//! Comments on room gallery items. Everyone in the room who sees an item
//! reads its comments from people they see. The author or the item's sharer
//! deletes a comment.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::hints::{notify, Change};
use super::{
    member_room, parse_id, people, room_closed, sees_sql, visible_item, Room, MAX_LISTED_COMMENTS,
};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::common_ground::{db_error, err, limited, GALLERY_COMMENT_LIMIT};
use crate::{auth::routes::CloudSession, server::ServerState};

const MAX_BODY_CHARS: usize = 2000;

fn comment_not_found() -> Response {
    err(
        "common_ground_gallery_comment_not_found",
        "Comment not found.",
        StatusCode::NOT_FOUND,
    )
}

/// A comment as clients see it.
fn comment_json(
    comment_id: Uuid,
    person: Value,
    body: &str,
    mine: bool,
    created_at: DateTime<Utc>,
) -> Value {
    json!({
        "commentId": comment_id,
        "person": person,
        "body": body,
        "mine": mine,
        "createdAt": created_at,
    })
}

/// The newest [`MAX_LISTED_COMMENTS`] comments on `item_id` that `viewer`
/// sees, oldest first.
pub(super) async fn load(
    pool: &PgPool,
    room: &Room,
    viewer: &str,
    item_id: Uuid,
) -> sqlx_core::Result<Vec<Value>> {
    let rows: Vec<(Uuid, String, String, DateTime<Utc>)> = query_as(&format!(
        "SELECT comment_id, account_id, body, created_at FROM (
             SELECT comment.comment_id, comment.account_id, comment.body, comment.created_at
             FROM cloud_common_ground_room_gallery_comments comment
             JOIN cloud_common_ground_room_gallery_items item ON item.item_id = comment.item_id
             WHERE comment.item_id = $1 AND {sees}
             ORDER BY comment.created_at DESC, comment.comment_id DESC
             LIMIT $3) newest
         ORDER BY created_at, comment_id",
        sees = sees_sql("$2", "comment.account_id", "item.room_id"),
    ))
    .bind(item_id)
    .bind(viewer)
    .bind(MAX_LISTED_COMMENTS)
    .fetch_all(pool)
    .await?;
    let ids: Vec<String> = rows.iter().map(|row| row.1.clone()).collect();
    let people = people(pool, room, viewer, ids).await?;
    Ok(rows
        .into_iter()
        .filter_map(|(comment_id, author, body, created_at)| {
            let person = people.get(&author)?.clone();
            Some(comment_json(
                comment_id,
                person,
                &body,
                author == viewer,
                created_at,
            ))
        })
        .collect())
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(in crate::common_ground) struct CommentRequest {
    body: String,
}

/// `POST /v1/cloud/common-ground/rooms/:code/gallery/:item_id/comments`:
/// comments on an item you see, in an open room.
pub(in crate::common_ground) async fn add_comment(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    Path((code, item_id)): Path<(String, String)>,
    body: Option<Json<CommentRequest>>,
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
    let item = match visible_item(pool, &room, viewer, &item_id).await {
        Ok(item) => item,
        Err(response) => return *response,
    };
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let text = body.body.trim();
    if text.is_empty() || text.chars().count() > MAX_BODY_CHARS {
        return err(
            "common_ground_invalid_gallery_comment",
            "Write 1 to 2,000 characters.",
            StatusCode::BAD_REQUEST,
        );
    }
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_limit(GALLERY_COMMENT_LIMIT, viewer)
        .await
    {
        return limited(retry_after);
    }
    let comment_id = Uuid::new_v4();
    let result = async {
        let mut tx = pool.begin().await?;
        let created: Option<(DateTime<Utc>,)> = query_as(
            "INSERT INTO cloud_common_ground_room_gallery_comments
                 (comment_id, item_id, account_id, body)
             SELECT $1, item.item_id, $3, $4 FROM cloud_common_ground_room_gallery_items item
             WHERE item.item_id = $2
             RETURNING created_at",
        )
        .bind(comment_id)
        .bind(item.item_id)
        .bind(viewer)
        .bind(text)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((created_at,)) = created else {
            return Ok(None);
        };
        notify(
            &mut tx,
            room.room_id,
            &room.code,
            &[item.item_id],
            Change::Item,
            None,
        )
        .await?;
        tx.commit().await?;
        let people = people(pool, &room, viewer, vec![viewer.to_string()]).await?;
        Ok::<_, sqlx_core::Error>(Some((created_at, people)))
    }
    .await;
    match result {
        Ok(Some((created_at, people))) => {
            let person = people.get(viewer).cloned().unwrap_or(Value::Null);
            let comment = comment_json(comment_id, person, text, true, created_at);
            (StatusCode::CREATED, Json(json!({ "comment": comment }))).into_response()
        }
        // The item was removed meanwhile.
        Ok(None) => super::item_not_found(),
        Err(error) => db_error(error),
    }
}

/// `DELETE /v1/cloud/common-ground/rooms/:code/gallery/:item_id/comments/:comment_id`:
/// the comment's author or the item's sharer deletes it, in an open or
/// closed room. Anyone else gets 404.
pub(in crate::common_ground) async fn delete_comment(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((code, item_id, comment_id)): Path<(String, String, String)>,
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
    let Some(comment_id) = parse_id(&comment_id) else {
        return comment_not_found();
    };
    let sharer = item.sharer == viewer;
    let result = async {
        let mut tx = pool.begin().await?;
        let deleted: Option<(Uuid,)> = query_as(
            "DELETE FROM cloud_common_ground_room_gallery_comments
             WHERE comment_id = $1 AND item_id = $2 AND ($4 OR account_id = $3)
             RETURNING comment_id",
        )
        .bind(comment_id)
        .bind(item.item_id)
        .bind(viewer)
        .bind(sharer)
        .fetch_optional(&mut *tx)
        .await?;
        if deleted.is_none() {
            return Ok(false);
        }
        notify(
            &mut tx,
            room.room_id,
            &room.code,
            &[item.item_id],
            Change::Item,
            None,
        )
        .await?;
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(true)
    }
    .await;
    match result {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => comment_not_found(),
        Err(error) => db_error(error),
    }
}
