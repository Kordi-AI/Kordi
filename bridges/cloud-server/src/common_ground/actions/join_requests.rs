//! Ask to join: a person in a room asks to join a group started from it.
//! System posts the request as a card in the group chat; an approver
//! approves or declines it there or in the room. Approving adds the person
//! the same way accepting a room invitation does.

mod approve;
mod ask;
mod decide;

pub(in crate::common_ground) use ask::ask_to_join;
pub(in crate::common_ground) use decide::decide_join_request;
use decide::{lock_for_decision, mark_decided};

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{executor::Executor, query::query, query_as::query_as};
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::people_by_id;
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::auth::routes::CloudSession;
use crate::chat_sync::{models::SendMessageRequest, store as chat};
use crate::common_ground::{db_error, err, limited, rooms, JOIN_REQUEST_LIMIT, SYSTEM_NOTICE_KIND};
use crate::document_shares::access::clean_display_name;
use crate::server::ServerState;
use crate::system_account::SYSTEM_ACCOUNT_ID;

/// The block type of the card in the group chat and of every snapshot.
const BLOCK_TYPE: &str = "group_join_request";

/// Who decides on requests to join a group, as a condition on the group's
/// conversation member row aliased `member`: an active owner or admin (the
/// creator is the owner). [`can_decide`], the card's `approverIds` and the
/// room's `requests` all use it, so switching to "any active member" means
/// dropping the role check here.
pub(in crate::common_ground) const APPROVER_SQL: &str =
    "member.membership_state = 'active' AND member.role IN ('owner', 'admin')";

/// Whether `account` may approve or decline requests to join the group
/// whose conversation is `conversation_id`. See [`APPROVER_SQL`].
pub(in crate::common_ground) async fn can_decide<'e, E>(
    executor: E,
    conversation_id: Uuid,
    account: &str,
) -> sqlx_core::Result<bool>
where
    E: Executor<'e, Database = Postgres>,
{
    let (decides,): (bool,) = query_as(&format!(
        "SELECT EXISTS (SELECT 1 FROM cloud_chat_conversation_members member
                        WHERE member.conversation_id = $1 AND member.account_id = $2
                          AND {APPROVER_SQL})"
    ))
    .bind(conversation_id)
    .bind(account)
    .fetch_one(executor)
    .await?;
    Ok(decides)
}

/// The current approvers of a group, owners first, without service accounts.
async fn approver_ids(pool: &PgPool, conversation_id: Uuid) -> sqlx_core::Result<Vec<String>> {
    let rows: Vec<(String,)> = query_as(&format!(
        "SELECT member.account_id FROM cloud_chat_conversation_members member
         WHERE member.conversation_id = $1 AND {APPROVER_SQL}
           AND NOT (member.account_id = ANY($2))
         ORDER BY member.role = 'owner' DESC, member.joined_at, member.account_id"
    ))
    .bind(conversation_id)
    .bind(crate::system_account::service_account_ids())
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

async fn is_active_member<'e, E>(
    executor: E,
    conversation_id: Uuid,
    account: &str,
) -> sqlx_core::Result<bool>
where
    E: Executor<'e, Database = Postgres>,
{
    let (member,): (bool,) = query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_chat_conversation_members
                        WHERE conversation_id = $1 AND account_id = $2
                          AND membership_state = 'active')",
    )
    .bind(conversation_id)
    .bind(account)
    .fetch_one(executor)
    .await?;
    Ok(member)
}

/// A stored request with its room and group.
#[derive(Debug, Clone)]
struct JoinRequest {
    request_id: Uuid,
    room_id: Uuid,
    code: String,
    room_name: String,
    group_space_id: String,
    conversation_id: Uuid,
    group_name: String,
    requester: String,
    status: String,
    revision: i64,
    message_id: Option<Uuid>,
    decided_by: Option<String>,
}

type RequestRow = (
    Uuid,
    Uuid,
    String,
    String,
    String,
    Uuid,
    String,
    String,
    String,
    i64,
    Option<Uuid>,
    Option<String>,
);

impl JoinRequest {
    fn pending(&self) -> bool {
        self.status == "pending"
    }
}

/// The request with this id; `lock` holds its row until the transaction ends.
async fn load<'e, E>(
    executor: E,
    request_id: Uuid,
    lock: bool,
) -> sqlx_core::Result<Option<JoinRequest>>
where
    E: Executor<'e, Database = Postgres>,
{
    let sql = format!(
        "SELECT request.request_id, request.room_id, room.code, room.name, request.group_space_id,
                room_group.conversation_id, room_group.name, request.requester_account_id,
                request.status, request.revision, request.message_id, request.decided_by
         FROM cloud_common_ground_room_join_requests request
         JOIN cloud_common_ground_rooms room ON room.room_id = request.room_id
         JOIN cloud_common_ground_room_groups room_group
           ON room_group.group_space_id = request.group_space_id
         WHERE request.request_id = $1{}",
        if lock { " FOR UPDATE OF request" } else { "" }
    );
    let row: Option<RequestRow> = query_as(&sql)
        .bind(request_id)
        .fetch_optional(executor)
        .await?;
    Ok(row.map(
        |(
            request_id,
            room_id,
            code,
            room_name,
            group_space_id,
            conversation_id,
            group_name,
            requester,
            status,
            revision,
            message_id,
            decided_by,
        )| JoinRequest {
            request_id,
            room_id,
            code,
            room_name,
            group_space_id,
            conversation_id,
            group_name,
            requester,
            status,
            revision,
            message_id,
            decided_by,
        },
    ))
}

/// The request as clients see it, and as the card block in the group chat.
async fn snapshot(pool: &PgPool, request: &JoinRequest) -> sqlx_core::Result<Value> {
    let approvers = approver_ids(pool, request.conversation_id).await?;
    let mut ids = vec![request.requester.clone()];
    ids.extend(request.decided_by.clone());
    let people = people_by_id(pool, &ids).await?;
    let decided_by = request
        .decided_by
        .as_ref()
        .and_then(|id| people.get(id).cloned());
    Ok(json!({
        "type": BLOCK_TYPE,
        "requestId": request.request_id,
        "groupSpaceId": request.group_space_id,
        "conversationId": request.conversation_id,
        "groupName": request.group_name,
        "roomName": request.room_name,
        "requester": people.get(&request.requester).cloned().unwrap_or(Value::Null),
        "status": request.status,
        "approverIds": approvers,
        "decidedBy": decided_by,
        "revision": request.revision,
    }))
}

/// `{ "request": snapshot }` with `status`.
async fn respond(pool: &PgPool, status: StatusCode, request: &JoinRequest) -> Response {
    match snapshot(pool, request).await {
        Ok(snapshot) => (status, Json(json!({ "request": snapshot }))).into_response(),
        Err(error) => db_error(error),
    }
}

/// 409 for a request that was already decided or withdrawn.
async fn closed(pool: &PgPool, request: &JoinRequest) -> Response {
    match snapshot(pool, request).await {
        Ok(snapshot) => (
            StatusCode::CONFLICT,
            Json(json!({
                "errorCode": "common_ground_join_request_closed",
                "message": "This request was already answered.",
                "request": snapshot,
            })),
        )
            .into_response(),
        Err(error) => db_error(error),
    }
}

/// Replaces the card block in the request's message with the current
/// snapshot when the stored block is older. Best effort: the room view and
/// `GET` always read the stored request.
async fn sync_card(pool: &PgPool, request: &JoinRequest) {
    let Some(message_id) = request.message_id else {
        return;
    };
    let result = async {
        let block = snapshot(pool, request).await?;
        let revision = request.revision;
        chat::refresh_server_message_content(pool, SYSTEM_ACCOUNT_ID, message_id, |mut content| {
            let blocks = content["blocks"].as_array_mut()?;
            let old = blocks.iter_mut().find(|item| item["type"] == BLOCK_TYPE)?;
            if old["revision"].as_i64().unwrap_or_default() >= revision {
                return None;
            }
            *old = block;
            Some(content)
        })
        .await
        .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
        Ok::<_, sqlx_core::Error>(())
    }
    .await;
    if let Err(error) = result {
        eprintln!("[common-ground] Could not refresh a join request card: {error}");
    }
}

fn request_not_found() -> Response {
    err(
        "common_ground_join_request_not_found",
        "Request not found.",
        StatusCode::NOT_FOUND,
    )
}

fn group_not_found() -> Response {
    err(
        "common_ground_group_not_found",
        "Group not found.",
        StatusCode::NOT_FOUND,
    )
}

fn parse_id(value: &str) -> Option<Uuid> {
    value.trim().parse().ok()
}

/// `DELETE /v1/cloud/common-ground/rooms/:code/join-requests/:request_id`:
/// the requester withdraws a pending request.
pub(in crate::common_ground) async fn cancel_join_request(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((code, request_id)): Path<(String, String)>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let room_id = match rooms::my_room(pool, &code, viewer).await {
        Ok(Some((room_id, _))) => room_id,
        Ok(None) => return rooms::room_not_found(),
        Err(error) => return db_error(error),
    };
    let Some(request_id) = parse_id(&request_id) else {
        return request_not_found();
    };
    let result = async {
        let mut tx = pool.begin().await?;
        let Some(mut request) = load(&mut *tx, request_id, true).await? else {
            return Ok(None);
        };
        if request.room_id != room_id || request.requester != viewer {
            return Ok(None);
        }
        if !request.pending() {
            return Ok(Some((request, false)));
        }
        query(
            "UPDATE cloud_common_ground_room_join_requests
             SET status = 'cancelled', revision = revision + 1, decided_at = now()
             WHERE request_id = $1",
        )
        .bind(request_id)
        .execute(&mut *tx)
        .await?;
        request.status = "cancelled".to_string();
        request.revision += 1;
        rooms::notify_members(&mut tx, request.room_id, &request.code).await?;
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(Some((request, true)))
    }
    .await;
    match result {
        Ok(None) => request_not_found(),
        Ok(Some((request, false))) => closed(pool, &request).await,
        Ok(Some((request, true))) => {
            sync_card(pool, &request).await;
            respond(pool, StatusCode::OK, &request).await
        }
        Err(error) => db_error(error),
    }
}

/// The request when `viewer` may see it: the requester or an active member
/// of the group.
async fn visible_request(
    pool: &PgPool,
    request_id: &str,
    viewer: &str,
) -> Result<JoinRequest, Box<Response>> {
    let Some(request_id) = parse_id(request_id) else {
        return Err(Box::new(request_not_found()));
    };
    let request = match load(pool, request_id, false).await {
        Ok(Some(request)) => request,
        Ok(None) => return Err(Box::new(request_not_found())),
        Err(error) => return Err(Box::new(db_error(error))),
    };
    if request.requester == viewer {
        return Ok(request);
    }
    match is_active_member(pool, request.conversation_id, viewer).await {
        Ok(true) => Ok(request),
        Ok(false) => Err(Box::new(request_not_found())),
        Err(error) => Err(Box::new(db_error(error))),
    }
}

/// `GET /v1/cloud/common-ground/join-requests/:request_id`.
pub(in crate::common_ground) async fn read_join_request(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(request_id): Path<String>,
) -> Response {
    let pool = state.db_pool();
    match visible_request(pool, &request_id, &session.account_id).await {
        Ok(request) => respond(pool, StatusCode::OK, &request).await,
        Err(response) => *response,
    }
}
