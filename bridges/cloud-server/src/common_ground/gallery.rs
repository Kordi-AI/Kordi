//! Room gallery: people in a room share their own artifacts (documents and
//! files from their Kordi chats) with the room. Only current members see
//! the gallery; they read and comment and never edit. You share only your
//! own artifacts, may remove yours at any time, and leaving the room removes
//! them. A closed room keeps its gallery readable but takes no new items or
//! comments; removing your own item or comment still works.
//!
//! An item shows only while its sharer is still in the room, and only to a
//! member with no block either way with the sharer ([`sees_sql`]); anything
//! else answers as not found. A comment shows on the same terms for its
//! author. A gallery item never opens the attachment through the attachment
//! or document routes: only `gallery/:item_id/content` serves it, after the
//! same check.

mod artifacts;
mod comments;
mod content;
mod copies;
mod hints;
mod refresh;
mod share;

pub(super) use artifacts::candidates;
pub(super) use comments::{add_comment, delete_comment};
pub(super) use content::content;
pub(super) use hints::forget;
pub(crate) use refresh::refresh_gallery_copies;
pub(super) use share::share;

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::{db_error, err, rooms};
use crate::{auth::routes::CloudSession, server::ServerState};

/// Items one person may have in one room.
pub(super) const MAX_ITEMS_PER_PERSON: i64 = 20;
/// Items `GET gallery` lists, newest first.
const MAX_LISTED_ITEMS: i64 = 200;
/// Comments an item lists: the newest ones, oldest first.
const MAX_LISTED_COMMENTS: i64 = 200;

/// SQL that is true when the account in `viewer` sees the account in
/// `person` in the room in `room` (all SQL expressions): `person` is still
/// a member there, and neither blocked the other. Membership is the lobby's
/// rule (members who have not left); the block test is the
/// `cloud_accounts_blocked_either_way` function that every Grounding
/// visibility rule applies. The viewer always sees themselves.
fn sees_sql(viewer: &str, person: &str, room: &str) -> String {
    format!(
        "(EXISTS (SELECT 1 FROM cloud_common_ground_room_members present
                  WHERE present.room_id = {room} AND present.account_id = {person}
                    AND present.left_at IS NULL)
          AND NOT cloud_accounts_blocked_either_way({viewer}, {person}))"
    )
}

/// A room the viewer is in and has not left.
pub(super) struct Room {
    pub room_id: Uuid,
    pub code: String,
    pub open: bool,
}

/// The room for `code` when `viewer` is a member who has not left, or the
/// room routes' 404.
async fn member_room(pool: &PgPool, code: &str, viewer: &str) -> Result<Room, Box<Response>> {
    match rooms::my_room(pool, code, viewer).await {
        Ok(Some((room_id, open))) => Ok(Room {
            room_id,
            code: code.to_string(),
            open,
        }),
        Ok(None) => Err(Box::new(rooms::room_not_found())),
        Err(error) => Err(Box::new(db_error(error))),
    }
}

fn room_closed() -> Response {
    err(
        "common_ground_room_closed",
        "This room has closed.",
        StatusCode::CONFLICT,
    )
}

fn item_not_found() -> Response {
    err(
        "common_ground_gallery_item_not_found",
        "Item not found.",
        StatusCode::NOT_FOUND,
    )
}

fn parse_id(value: &str) -> Option<Uuid> {
    value.trim().parse().ok()
}

/// An item the viewer sees.
struct VisibleItem {
    item_id: Uuid,
    sharer: String,
    attachment_id: String,
}

/// The item `item_id` in `room` when `viewer` sees it.
async fn visible_item(
    pool: &PgPool,
    room: &Room,
    viewer: &str,
    item_id: &str,
) -> Result<VisibleItem, Box<Response>> {
    let Some(item_id) = parse_id(item_id) else {
        return Err(Box::new(item_not_found()));
    };
    let row: Result<Option<(String, String)>, _> = query_as(&format!(
        "SELECT item.account_id, item.attachment_id
         FROM cloud_common_ground_room_gallery_items item
         WHERE item.item_id = $1 AND item.room_id = $2 AND {sees}",
        sees = sees_sql("$3", "item.account_id", "item.room_id"),
    ))
    .bind(item_id)
    .bind(room.room_id)
    .bind(viewer)
    .fetch_optional(pool)
    .await;
    match row {
        Ok(Some((sharer, attachment_id))) => Ok(VisibleItem {
            item_id,
            sharer,
            attachment_id,
        }),
        Ok(None) => Err(Box::new(item_not_found())),
        Err(error) => Err(Box::new(db_error(error))),
    }
}

/// Person objects for these members of `room`, as the lobby shows them to
/// `viewer` (see [`rooms::member_people`]); the viewer appears as themself.
async fn people(
    pool: &PgPool,
    room: &Room,
    viewer: &str,
    ids: Vec<String>,
) -> sqlx_core::Result<HashMap<String, Value>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let profile: Option<(String,)> = query_as(
        "SELECT profile_id FROM cloud_common_ground_room_members
         WHERE room_id = $1 AND account_id = $2",
    )
    .bind(room.room_id)
    .bind(viewer)
    .fetch_optional(pool)
    .await?;
    let profile = profile.map(|(profile_id,)| profile_id);
    let found =
        rooms::member_people(pool, room.room_id, viewer, profile.as_deref(), Some(&ids)).await?;
    Ok(found.into_iter().collect())
}

/// Which items [`load_items`] reads.
enum Filter<'a> {
    All,
    Item(Uuid),
    Attachments(&'a [String]),
}

type ItemRow = (
    Uuid,
    String,
    String,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<String>,
    String,
    DateTime<Utc>,
    i64,
);

/// The items of `room` that `viewer` sees, newest first, as `GalleryItem`
/// objects. `commentCount` counts the comments the viewer sees, up to the
/// [`MAX_LISTED_COMMENTS`] an item lists.
async fn load_items(
    pool: &PgPool,
    room: &Room,
    viewer: &str,
    filter: Filter<'_>,
) -> sqlx_core::Result<Vec<Value>> {
    let (item_id, attachments) = match filter {
        Filter::All => (None, None),
        Filter::Item(item_id) => (Some(item_id), None),
        Filter::Attachments(ids) => (None, Some(ids)),
    };
    let rows: Vec<ItemRow> = query_as(&format!(
        "SELECT item.item_id, item.attachment_id, item.title, item.file_name,
                COALESCE(attachment.content_type, attachment.detected_content_type),
                COALESCE(octet_length(contents.source)::bigint, attachment.size_bytes),
                item.topic, item.preview, item.account_id, item.created_at,
                (SELECT COUNT(*) FROM (
                     SELECT 1 FROM cloud_common_ground_room_gallery_comments comment
                     WHERE comment.item_id = item.item_id AND {comment_sees}
                     LIMIT $6) listed)
         FROM cloud_common_ground_room_gallery_items item
         JOIN cloud_attachments attachment ON attachment.attachment_id = item.attachment_id
         LEFT JOIN cloud_document_contents contents
           ON contents.attachment_id = item.attachment_id
         WHERE item.room_id = $1 AND {item_sees}
           AND ($3::uuid IS NULL OR item.item_id = $3)
           AND ($4::text[] IS NULL OR item.attachment_id = ANY($4))
         ORDER BY item.created_at DESC, item.item_id DESC
         LIMIT $5",
        comment_sees = sees_sql("$2", "comment.account_id", "item.room_id"),
        item_sees = sees_sql("$2", "item.account_id", "item.room_id"),
    ))
    .bind(room.room_id)
    .bind(viewer)
    .bind(item_id)
    .bind(attachments)
    .bind(MAX_LISTED_ITEMS)
    .bind(MAX_LISTED_COMMENTS)
    .fetch_all(pool)
    .await?;
    let ids: Vec<String> = rows.iter().map(|row| row.8.clone()).collect();
    let people = people(pool, room, viewer, ids).await?;
    Ok(rows
        .into_iter()
        .filter_map(
            |(
                item_id,
                attachment_id,
                title,
                file_name,
                content_type,
                size_bytes,
                topic,
                preview,
                sharer,
                created_at,
                comments,
            )| {
                // A sharer who left between the two reads takes the item along.
                let person = people.get(&sharer)?.clone();
                Some(json!({
                    "itemId": item_id,
                    "attachmentId": attachment_id,
                    "title": title,
                    "fileName": file_name,
                    "contentType": content_type,
                    "sizeBytes": size_bytes,
                    "topic": topic,
                    "preview": preview,
                    "person": person,
                    "mine": sharer == viewer,
                    "commentCount": comments,
                    "createdAt": created_at,
                }))
            },
        )
        .collect())
}

/// How many items `account` has in the room.
async fn own_count<'e, E>(executor: E, room_id: Uuid, account: &str) -> sqlx_core::Result<i64>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    let (count,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_common_ground_room_gallery_items
         WHERE room_id = $1 AND account_id = $2",
    )
    .bind(room_id)
    .bind(account)
    .fetch_one(executor)
    .await?;
    Ok(count)
}

/// `GET /v1/cloud/common-ground/rooms/:code/gallery`: the items you see,
/// newest first, and whether you may share more (an open room where you
/// have fewer than [`MAX_ITEMS_PER_PERSON`]).
pub(in crate::common_ground) async fn list(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(code): Path<String>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let room = match member_room(pool, &code, viewer).await {
        Ok(room) => room,
        Err(response) => return *response,
    };
    let result = async {
        let items = load_items(pool, &room, viewer, Filter::All).await?;
        let mine = own_count(pool, room.room_id, viewer).await?;
        Ok::<_, sqlx_core::Error>((items, room.open && mine < MAX_ITEMS_PER_PERSON))
    }
    .await;
    match result {
        Ok((items, can_share)) => (
            StatusCode::OK,
            Json(json!({ "items": items, "canShare": can_share })),
        )
            .into_response(),
        Err(error) => db_error(error),
    }
}

/// `GET /v1/cloud/common-ground/rooms/:code/gallery/:item_id`: the item and
/// the newest [`MAX_LISTED_COMMENTS`] comments you see, oldest first.
pub(in crate::common_ground) async fn read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((code, item_id)): Path<(String, String)>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let room = match member_room(pool, &code, viewer).await {
        Ok(room) => room,
        Err(response) => return *response,
    };
    let item = match visible_item(pool, &room, viewer, &item_id).await {
        Ok(item) => item,
        Err(response) => return *response,
    };
    let result = async {
        let found = load_items(pool, &room, viewer, Filter::Item(item.item_id)).await?;
        let comments = comments::load(pool, &room, viewer, item.item_id).await?;
        Ok::<_, sqlx_core::Error>((found.into_iter().next(), comments))
    }
    .await;
    match result {
        Ok((Some(item), comments)) => (
            StatusCode::OK,
            Json(json!({ "item": item, "comments": comments })),
        )
            .into_response(),
        Ok((None, _)) => item_not_found(),
        Err(error) => db_error(error),
    }
}

/// `DELETE /v1/cloud/common-ground/rooms/:code/gallery/:item_id`: the sharer
/// removes their item, in an open or closed room. Anyone else gets 404.
pub(in crate::common_ground) async fn remove(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((code, item_id)): Path<(String, String)>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let room = match member_room(pool, &code, viewer).await {
        Ok(room) => room,
        Err(response) => return *response,
    };
    let Some(item_id) = parse_id(&item_id) else {
        return item_not_found();
    };
    let result = async {
        let mut tx = pool.begin().await?;
        let removed: Option<(Uuid,)> = query_as(
            "DELETE FROM cloud_common_ground_room_gallery_items
             WHERE item_id = $1 AND room_id = $2 AND account_id = $3 RETURNING item_id",
        )
        .bind(item_id)
        .bind(room.room_id)
        .bind(viewer)
        .fetch_optional(&mut *tx)
        .await?;
        if removed.is_none() {
            return Ok(false);
        }
        hints::notify(
            &mut tx,
            room.room_id,
            &room.code,
            &[item_id],
            hints::Change::List,
            None,
        )
        .await?;
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(true)
    }
    .await;
    match result {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => item_not_found(),
        Err(error) => db_error(error),
    }
}

#[cfg(test)]
pub(super) use artifacts::{file_name_for, title_for, Artifact};
#[cfg(test)]
pub(super) use copies::{candidate_title, copies, readable_text, text_like, Copies, HEAD_CHARS};
