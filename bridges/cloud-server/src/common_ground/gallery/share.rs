//! `POST gallery`: sharing your own artifacts in a room, with the title and
//! a short text preview copied from their text (see [`super::copies`]).

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
use super::copies::{copies, readable_text, reads_text, Copies, MAX_PREVIEW_SOURCE_BYTES};
use super::hints::{notify, Change};
use super::MAX_ITEMS_PER_PERSON;
use super::{load_items, member_room, own_count, room_closed, Filter, Room};
use crate::common_ground::{db_error, err};
use crate::{auth::routes::CloudSession, server::ServerState};

/// Artifacts one request may share.
const MAX_SHARED_AT_ONCE: usize = 8;
const MAX_TOPIC_CHARS: usize = 80;

/// The text of a text artifact up to the preview size (see
/// [`reads_text`] and [`readable_text`]): its current Kordi document text
/// when it has one, else its bytes. A failed read gives no text rather
/// than failing the share.
async fn read_text(state: &ServerState, artifact: &Artifact) -> Option<String> {
    if !reads_text(artifact) {
        return None;
    }
    let stored: Option<(String,)> =
        query_as("SELECT source FROM cloud_document_contents WHERE attachment_id = $1")
            .bind(&artifact.attachment_id)
            .fetch_optional(state.db_pool())
            .await
            .ok()?;
    if let Some((source,)) = stored {
        return readable_text(source.as_bytes()).map(str::to_string);
    }
    let bytes = crate::attachments::fetch::fetch_attachment_bytes(
        state,
        &artifact.object_key,
        MAX_PREVIEW_SOURCE_BYTES,
    )
    .await
    .ok()?;
    readable_text(&bytes).map(str::to_string)
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

/// Stores the artifacts not yet in the gallery and tells the room once
/// about the ones it added. The member row lock serializes shares by one
/// person in one room with each other and with leaving.
async fn store(
    tx: &mut Transaction<'_, Postgres>,
    room: &Room,
    viewer: &str,
    new: &[(Artifact, Copies)],
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
    let mut added = Vec::new();
    for (artifact, copies) in new {
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
        .bind(&copies.title)
        .bind(&artifact.file_name)
        .bind(topic)
        .bind(&copies.preview)
        .fetch_optional(&mut **tx)
        .await?;
        added.extend(inserted.map(|(item_id,)| item_id));
    }
    notify(tx, room.room_id, &room.code, &added, Change::List, None).await?;
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
    let mut found = match eligible(pool, viewer, Some(&ids), ids.len() as i64).await {
        Ok(found) => found,
        Err(error) => return db_error(error),
    };
    // New items, and the hint's `itemIds`, follow the order asked.
    found.sort_by_key(|artifact| ids.iter().position(|id| *id == artifact.attachment_id));
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
    let texts = futures_util::future::join_all(new.iter().map(|a| read_text(&state, a))).await;
    let new: Vec<(Artifact, Copies)> = new
        .into_iter()
        .zip(texts)
        .map(|(artifact, text)| {
            let copies = copies(&artifact, text.as_deref());
            (artifact, copies)
        })
        .collect();
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
