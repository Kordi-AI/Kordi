//! `POST gallery`: sharing your own artifacts in a room, with a short text
//! preview copied from text files.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query_as::query_as, transaction::Transaction};
use sqlx_postgres::Postgres;
use uuid::Uuid;

use super::artifacts::{already_shared, eligible, Artifact};
use super::MAX_ITEMS_PER_PERSON;
use super::{load_items, member_room, notify, own_count, room_closed, Filter, Room};
use crate::common_ground::{db_error, err};
use crate::{auth::routes::CloudSession, server::ServerState};

/// Artifacts one request may share.
const MAX_SHARED_AT_ONCE: usize = 8;
const MAX_TOPIC_CHARS: usize = 80;
/// Text files up to this size get a preview.
const MAX_PREVIEW_SOURCE_BYTES: usize = 256 * 1024;
const PREVIEW_CHARS: usize = 800;

/// File extensions read as text when the content type does not say.
const TEXT_EXTENSIONS: &[&str] = &[
    "adoc", "c", "cc", "cfg", "conf", "cpp", "cs", "css", "csv", "go", "h", "hpp", "htm", "html",
    "ini", "java", "js", "json", "jsonl", "jsx", "kt", "log", "markdown", "md", "mdx", "mjs",
    "php", "py", "rb", "rs", "rst", "scss", "sh", "sql", "swift", "toml", "ts", "tsv", "tsx",
    "txt", "vue", "xml", "yaml", "yml",
];

/// Non-`text/*` content types that are text.
const TEXT_APPLICATION_TYPES: &[&str] = &[
    "application/json",
    "application/ld+json",
    "application/x-ndjson",
    "application/xml",
    "application/javascript",
    "application/x-javascript",
    "application/x-sh",
    "application/x-yaml",
    "application/yaml",
    "application/toml",
    "application/sql",
    "application/xhtml+xml",
];

/// Whether a file is text a preview can quote: Markdown, plain text, code,
/// CSV/TSV or JSON by its content type, or by its extension when the type
/// is missing or generic.
pub(in crate::common_ground) fn text_like(content_type: Option<&str>, file_name: &str) -> bool {
    let essence = content_type
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if essence.starts_with("text/") || TEXT_APPLICATION_TYPES.contains(&essence.as_str()) {
        return true;
    }
    if !essence.is_empty() && essence != "application/octet-stream" {
        return false;
    }
    let base = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name);
    match base.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => {
            TEXT_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        }
        _ => false,
    }
}

/// The first [`PREVIEW_CHARS`] characters of `bytes` when they are valid
/// UTF-8 text; `None` for anything else or blank text.
pub(in crate::common_ground) fn preview_text(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    // Postgres text cannot hold NUL, and text files have none.
    if text.contains('\0') || text.trim().is_empty() {
        return None;
    }
    Some(text.chars().take(PREVIEW_CHARS).collect())
}

/// The preview of a text artifact up to [`MAX_PREVIEW_SOURCE_BYTES`]: its
/// current Kordi document text when it has one, else its bytes. A failed
/// read gives no preview rather than failing the share.
async fn read_preview(state: &ServerState, artifact: &Artifact) -> Option<String> {
    if !text_like(artifact.content_type.as_deref(), &artifact.file_name)
        || artifact
            .size_bytes
            .is_some_and(|size| size > MAX_PREVIEW_SOURCE_BYTES as i64)
    {
        return None;
    }
    let stored: Option<(String,)> =
        query_as("SELECT source FROM cloud_document_contents WHERE attachment_id = $1")
            .bind(&artifact.attachment_id)
            .fetch_optional(state.db_pool())
            .await
            .ok()?;
    if let Some((source,)) = stored {
        return preview_text(source.as_bytes());
    }
    let bytes = crate::attachments::fetch::fetch_attachment_bytes(
        state,
        &artifact.object_key,
        MAX_PREVIEW_SOURCE_BYTES,
    )
    .await
    .ok()?;
    preview_text(&bytes)
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(in crate::common_ground) struct ShareRequest {
    attachment_ids: Vec<String>,
    topic: Option<String>,
}

fn invalid(message: &str) -> Response {
    err(
        "common_ground_invalid_gallery",
        message,
        StatusCode::BAD_REQUEST,
    )
}

/// The distinct ids and the topic, or the response for a bad body.
fn parse(body: ShareRequest) -> Result<(Vec<String>, Option<String>), Box<Response>> {
    let count = body.attachment_ids.len();
    let mut ids: Vec<String> = Vec::new();
    for id in body.attachment_ids {
        let id = id.trim().to_string();
        if id.is_empty() {
            ids.clear();
            break;
        }
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.is_empty() || count > MAX_SHARED_AT_ONCE {
        return Err(Box::new(invalid("Pick 1 to 8 artifacts.")));
    }
    let topic = body
        .topic
        .map(|topic| topic.trim().to_string())
        .filter(|topic| !topic.is_empty());
    if topic
        .as_deref()
        .is_some_and(|topic| topic.chars().count() > MAX_TOPIC_CHARS)
    {
        return Err(Box::new(invalid("Keep the topic to 80 characters.")));
    }
    Ok((ids, topic))
}

/// How storing the new items went.
enum Stored {
    Done,
    /// The viewer left the room meanwhile.
    Gone,
    Limit,
}

/// Stores the artifacts not yet in the gallery and tells the room. The
/// member row lock serializes shares by one person in one room with each
/// other and with leaving.
async fn store(
    tx: &mut Transaction<'_, Postgres>,
    room: &Room,
    viewer: &str,
    new: &[(Artifact, Option<String>)],
    topic: Option<&str>,
) -> sqlx_core::Result<Stored> {
    let member: Option<(i32,)> = query_as(
        "SELECT 1 FROM cloud_common_ground_room_members
         WHERE room_id = $1 AND account_id = $2 AND left_at IS NULL FOR UPDATE",
    )
    .bind(room.room_id)
    .bind(viewer)
    .fetch_optional(&mut **tx)
    .await?;
    if member.is_none() {
        return Ok(Stored::Gone);
    }
    let ids: Vec<String> = new.iter().map(|(a, _)| a.attachment_id.clone()).collect();
    let present: Vec<(String,)> = query_as(
        "SELECT attachment_id FROM cloud_common_ground_room_gallery_items
         WHERE room_id = $1 AND attachment_id = ANY($2)",
    )
    .bind(room.room_id)
    .bind(&ids)
    .fetch_all(&mut **tx)
    .await?;
    let adding = new.len() - present.len();
    if own_count(&mut **tx, room.room_id, viewer).await? + adding as i64 > MAX_ITEMS_PER_PERSON {
        return Ok(Stored::Limit);
    }
    for (artifact, preview) in new {
        let inserted: Option<(Uuid,)> = query_as(
            "INSERT INTO cloud_common_ground_room_gallery_items
                 (item_id, room_id, account_id, attachment_id, title, file_name, topic, preview)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (room_id, attachment_id) DO NOTHING RETURNING item_id",
        )
        .bind(Uuid::new_v4())
        .bind(room.room_id)
        .bind(viewer)
        .bind(&artifact.attachment_id)
        .bind(&artifact.title)
        .bind(&artifact.file_name)
        .bind(topic)
        .bind(preview)
        .fetch_optional(&mut **tx)
        .await?;
        if let Some((item_id,)) = inserted {
            notify(tx, room.room_id, &room.code, item_id, None).await?;
        }
    }
    Ok(Stored::Done)
}

/// `POST /v1/cloud/common-ground/rooms/:code/gallery`: shares 1 to 8 of your
/// own artifacts in an open room, with an optional topic. Returns the items
/// for those ids in the order asked, including ones already shared, which
/// stay as they were.
pub(in crate::common_ground) async fn share(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(code): Path<String>,
    body: Option<Json<ShareRequest>>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let room = match member_room(pool, &code, viewer).await {
        Ok(room) => room,
        Err(response) => return *response,
    };
    if !room.open {
        return room_closed();
    }
    let (ids, topic) = match parse(body.map(|Json(body)| body).unwrap_or_default()) {
        Ok(parsed) => parsed,
        Err(response) => return *response,
    };
    let found = match eligible(pool, viewer, Some(&ids), ids.len() as i64).await {
        Ok(found) => found,
        Err(error) => return db_error(error),
    };
    if found.len() != ids.len() {
        return err(
            "common_ground_gallery_not_shareable",
            "You can share only your own artifacts.",
            StatusCode::BAD_REQUEST,
        );
    }
    let shared = match already_shared(pool, room.room_id, &ids).await {
        Ok(shared) => shared,
        Err(error) => return db_error(error),
    };
    let new: Vec<Artifact> = found
        .into_iter()
        .filter(|artifact| !shared.contains(&artifact.attachment_id))
        .collect();
    let previews =
        futures_util::future::join_all(new.iter().map(|a| read_preview(&state, a))).await;
    let new: Vec<(Artifact, Option<String>)> = new.into_iter().zip(previews).collect();
    let stored = async {
        let mut tx = pool.begin().await?;
        let stored = store(&mut tx, &room, viewer, &new, topic.as_deref()).await?;
        if matches!(stored, Stored::Done) {
            tx.commit().await?;
        }
        Ok::<_, sqlx_core::Error>(stored)
    }
    .await;
    match stored {
        Ok(Stored::Done) => {}
        Ok(Stored::Gone) => return crate::common_ground::rooms::room_not_found(),
        Ok(Stored::Limit) => {
            return err(
                "common_ground_gallery_limit",
                "You can share up to 20 items in a room.",
                StatusCode::CONFLICT,
            )
        }
        Err(error) => return db_error(error),
    }
    match load_items(pool, &room, viewer, Filter::Attachments(&ids)).await {
        Ok(mut items) => {
            let position = |item: &Value| {
                let id = item["attachmentId"].as_str().unwrap_or_default();
                ids.iter().position(|asked| asked == id)
            };
            items.sort_by_key(position);
            (StatusCode::CREATED, Json(json!({ "items": items }))).into_response()
        }
        Err(error) => db_error(error),
    }
}
