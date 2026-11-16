//! The viewer's own artifacts a room gallery may take, and
//! `GET gallery/candidates`.
//!
//! The ownership rules are the ones `common_ground::documents` applies to
//! card sources: an attachment the viewer owns and finalized, not a
//! forwarded copy, and not written by an agent run someone else asked for.
//! On top of that it must be an artifact, as the chat's Artifacts tab lists
//! them, rather than any chat upload: a file an agent run produced
//! (`cloud_agent_run_artifacts`), a document an agent created
//! (`cloud_agent_run_documents`), or a Kordi document, that is Markdown or
//! HTML by the rule of `document_shares::render::document_format`. Any file
//! type counts for the first two.

use std::collections::HashSet;
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::{member_room, Room};
use crate::common_ground::db_error;
use crate::{auth::routes::CloudSession, server::ServerState};

/// Artifacts `GET gallery/candidates` lists, newest first.
const MAX_CANDIDATES: i64 = 50;
const MAX_TITLE_CHARS: usize = 200;
const MAX_FILE_NAME_CHARS: usize = 255;
const UNTITLED: &str = "Untitled";

/// Eligible attachments of `$1`, newest first, at most `$3`; only the ids
/// in `$2` when it is not null. The name is the one an agent artifact, an
/// agent document or the chat message gave the attachment, as in
/// `common_ground::documents`.
const ELIGIBLE_SQL: &str = "
WITH owned AS MATERIALIZED (
    SELECT a.attachment_id, a.object_key, a.document_title, a.size_bytes, a.finalized_at,
           COALESCE(a.content_type, a.detected_content_type) AS content_type,
           lower(btrim(split_part(COALESCE(a.content_type, a.detected_content_type, ''), ';', 1)))
               AS essence,
           EXISTS (SELECT 1 FROM cloud_agent_run_artifacts artifact
                   WHERE artifact.attachment_id = a.attachment_id) AS run_artifact
    FROM cloud_attachments a
    WHERE a.owner_account_id = $1
      AND a.document_source_attachment_id IS NULL
      AND a.finalized_at IS NOT NULL
      AND ($2::text[] IS NULL OR a.attachment_id = ANY($2))
      AND NOT EXISTS (
          SELECT 1 FROM cloud_agent_run_documents doc
          JOIN cloud_agent_fallback_runs run ON run.run_id = doc.run_id
          WHERE doc.attachment_id = a.attachment_id AND run.requester_account_id <> $1)
      AND NOT EXISTS (
          SELECT 1 FROM cloud_agent_run_artifacts artifact
          JOIN cloud_agent_fallback_runs run ON run.run_id = artifact.run_id
          WHERE artifact.attachment_id = a.attachment_id AND run.requester_account_id <> $1)
),
kept AS (
    SELECT owned.*, doc.title AS doc_title, doc.file_name AS doc_file_name,
           doc.attachment_id IS NOT NULL AS run_document
    FROM owned
    LEFT JOIN cloud_agent_run_documents doc ON doc.attachment_id = owned.attachment_id
    WHERE owned.run_artifact OR doc.attachment_id IS NOT NULL
       OR owned.essence IN ('text/markdown', 'text/x-markdown', 'text/html',
                            'application/xhtml+xml', '', 'text/plain',
                            'application/octet-stream')
)
SELECT kept.attachment_id, kept.object_key, kept.document_title, kept.doc_title, named.name,
       kept.content_type,
       COALESCE(octet_length(contents.source)::bigint, kept.size_bytes),
       COALESCE(contents.updated_at, kept.finalized_at)::timestamptz AS updated_at
FROM kept
LEFT JOIN cloud_document_contents contents ON contents.attachment_id = kept.attachment_id
CROSS JOIN LATERAL (
    SELECT CASE WHEN char_length(btrim(found.name)) BETWEEN 1 AND 255
                THEN btrim(found.name) END AS name
    FROM (SELECT COALESCE(
        (SELECT artifact.name FROM cloud_agent_run_artifacts artifact
         WHERE artifact.attachment_id = kept.attachment_id
         ORDER BY artifact.created_at ASC LIMIT 1),
        kept.doc_file_name,
        (SELECT item->>'name'
         FROM cloud_chat_message_attachments link
         JOIN cloud_chat_messages message ON message.message_id = link.message_id
         CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(message.content->'legacy_attachments') = 'array'
                  THEN message.content->'legacy_attachments' ELSE '[]'::jsonb END) item
         WHERE link.attachment_id = kept.attachment_id
           AND item->>'attachmentId' = kept.attachment_id
         ORDER BY message.created_at ASC LIMIT 1)) AS name) found
) named
WHERE kept.run_artifact OR kept.run_document
   OR kept.essence IN ('text/markdown', 'text/x-markdown', 'text/html', 'application/xhtml+xml')
   OR lower(named.name) ~ '\\.(md|markdown|html|htm)$'
ORDER BY updated_at DESC, kept.attachment_id
LIMIT $3";

/// One artifact the viewer may share.
#[derive(Debug, Clone)]
pub(super) struct Artifact {
    pub attachment_id: String,
    pub object_key: String,
    pub title: String,
    pub file_name: String,
    pub content_type: Option<String>,
    pub size_bytes: Option<i64>,
    pub updated_at: DateTime<Utc>,
}

type ArtifactRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
    DateTime<Utc>,
);

/// `account`'s eligible artifacts, newest first, at most `limit`; only
/// `ids` when given.
pub(super) async fn eligible(
    pool: &PgPool,
    account: &str,
    ids: Option<&[String]>,
    limit: i64,
) -> sqlx_core::Result<Vec<Artifact>> {
    let rows: Vec<ArtifactRow> = query_as(ELIGIBLE_SQL)
        .bind(account)
        .bind(ids)
        .bind(limit)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                attachment_id,
                object_key,
                stored_title,
                doc_title,
                name,
                content_type,
                size_bytes,
                updated_at,
            )| Artifact {
                title: title_for(
                    stored_title.as_deref(),
                    doc_title.as_deref(),
                    name.as_deref(),
                ),
                file_name: file_name_for(name.as_deref()),
                attachment_id,
                object_key,
                content_type,
                size_bytes,
                updated_at,
            },
        )
        .collect())
}

/// Whitespace collapsed, at most `max` characters; `None` when empty.
fn clean(value: &str, max: usize) -> Option<String> {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = collapsed.chars().take(max).collect();
    (!cut.is_empty()).then_some(cut)
}

/// The file name without its folder and last extension, like
/// `document_shares::render::file_stem`.
fn stem(file_name: &str) -> &str {
    let base = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name);
    match base.rfind('.') {
        Some(index) if index > 0 => &base[..index],
        _ => base,
    }
}

/// The title a gallery shows: the title someone renamed the document to,
/// else an agent document's title, else the file name without its
/// extension, else "Untitled".
pub(in crate::common_ground) fn title_for(
    stored: Option<&str>,
    doc_title: Option<&str>,
    file_name: Option<&str>,
) -> String {
    [stored, doc_title]
        .into_iter()
        .flatten()
        .find_map(|title| clean(title, MAX_TITLE_CHARS))
        .or_else(|| file_name.and_then(|name| clean(stem(name), MAX_TITLE_CHARS)))
        .unwrap_or_else(|| UNTITLED.to_string())
}

/// The file name a gallery shows, never empty.
pub(in crate::common_ground) fn file_name_for(name: Option<&str>) -> String {
    name.and_then(|name| clean(name, MAX_FILE_NAME_CHARS))
        .unwrap_or_else(|| UNTITLED.to_string())
}

/// The attachments among `ids` already in the room's gallery.
pub(super) async fn already_shared(
    pool: &PgPool,
    room_id: Uuid,
    ids: &[String],
) -> sqlx_core::Result<HashSet<String>> {
    let rows: Vec<(String,)> = query_as(
        "SELECT attachment_id FROM cloud_common_ground_room_gallery_items
         WHERE room_id = $1 AND attachment_id = ANY($2)",
    )
    .bind(room_id)
    .bind(ids)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// `GET /v1/cloud/common-ground/rooms/:code/gallery/candidates`: your own
/// artifacts you may share, newest first, each with whether it is already
/// in this room's gallery.
pub(in crate::common_ground) async fn candidates(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(code): Path<String>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let room: Room = match member_room(pool, &code, viewer).await {
        Ok(room) => room,
        Err(response) => return *response,
    };
    let result = async {
        let artifacts = eligible(pool, viewer, None, MAX_CANDIDATES).await?;
        let ids: Vec<String> = artifacts.iter().map(|a| a.attachment_id.clone()).collect();
        let shared = already_shared(pool, room.room_id, &ids).await?;
        Ok::<_, sqlx_core::Error>((artifacts, shared))
    }
    .await;
    match result {
        Ok((artifacts, shared)) => {
            let artifacts: Vec<_> = artifacts
                .into_iter()
                .map(|artifact| {
                    json!({
                        "attachmentId": artifact.attachment_id,
                        "title": artifact.title,
                        "fileName": artifact.file_name,
                        "contentType": artifact.content_type,
                        "sizeBytes": artifact.size_bytes,
                        "updatedAt": artifact.updated_at,
                        "shared": shared.contains(&artifact.attachment_id),
                    })
                })
                .collect();
            (StatusCode::OK, Json(json!({ "artifacts": artifacts }))).into_response()
        }
        Err(error) => db_error(error),
    }
}
