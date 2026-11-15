//! Sending: an owner or admin invites Grounding people into a group.
//! Contacts are added directly; everyone else gets a pending invitation.

use std::collections::HashSet;
use std::sync::Arc;

use axum::{extract::State, http::StatusCode, response::IntoResponse, response::Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::lists::invitable;
use super::{admin_group, forbidden, shared_room_sql, Group, HINT, LIVE_SQL};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::auth::routes::CloudSession;
use crate::chat_sync::models::AddConversationMembersRequest;
use crate::chat_sync::store::{self as chat, StoreError};
use crate::common_ground::actions::{is_contact, people_by_id};
use crate::common_ground::{db_error, err, hint, limited, GROUP_INVITE_LIMIT};
use crate::server::ServerState;

/// Account ids one request may name.
const MAX_IDS: usize = 20;
/// Live pending invitations one person may have sent at a time.
const MAX_PENDING: i64 = 50;

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(in crate::common_ground) struct InviteRequest {
    group_space_id: String,
    account_ids: Vec<String>,
}

/// What happens to one named account.
enum Outcome {
    Contact,
    Pending,
    New,
    Skipped(&'static str),
}

fn bad_request(message: &str) -> Response {
    err(
        "common_ground_invalid_invitation",
        message,
        StatusCode::BAD_REQUEST,
    )
}

fn group_full() -> Response {
    err(
        "common_ground_group_full",
        "This group is full.",
        StatusCode::CONFLICT,
    )
}

/// `POST /v1/cloud/common-ground/group-invitations`.
pub(in crate::common_ground) async fn invite_to_group(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    body: Option<Json<InviteRequest>>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let mut seen = HashSet::new();
    let ids: Vec<String> = body
        .account_ids
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty() && seen.insert(id.clone()))
        .collect();
    if ids.is_empty() || ids.len() > MAX_IDS {
        return bad_request("Pick between 1 and 20 people.");
    }
    let group = match admin_group(pool, &body.group_space_id, viewer).await {
        Ok(Some(group)) => group,
        Ok(None) => return forbidden(),
        Err(error) => return db_error(error),
    };
    let outcomes = match classify(pool, &group, viewer, &ids).await {
        Ok(outcomes) => outcomes,
        Err(error) => return db_error(error),
    };
    let wanted: Vec<&String> = outcomes
        .iter()
        .filter(|(_, outcome)| matches!(outcome, Outcome::New))
        .map(|(id, _)| id)
        .collect();
    if !wanted.is_empty() {
        if let RateLimitDecision::Limited { retry_after } = rate_limiter
            .observe_account_limit(GROUP_INVITE_LIMIT, viewer)
            .await
        {
            return limited(retry_after);
        }
    }
    let contacts: Vec<String> = outcomes
        .iter()
        .filter(|(_, outcome)| matches!(outcome, Outcome::Contact))
        .map(|(id, _)| id.clone())
        .collect();
    if !contacts.is_empty() {
        let request = AddConversationMembersRequest {
            client_operation_id: Uuid::new_v4(),
            member_account_ids: contacts.clone(),
            replace: false,
        };
        match chat::add_conversation_members(pool, viewer, group.conversation_id, request).await {
            Ok(_) => {}
            Err(StoreError::Forbidden) => return forbidden(),
            Err(StoreError::InvalidInput("group member count is invalid")) => return group_full(),
            Err(error) => {
                eprintln!("[common-ground] Could not add contacts to a group: {error:?}");
                return err(
                    "common_ground_failed",
                    "Could not add them. Try again.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                );
            }
        }
    }
    let created = match create(pool, &group, viewer, &wanted).await {
        Ok(created) => created,
        Err(error) => return db_error(error),
    };
    let mut invited = Vec::new();
    let mut skipped = Vec::new();
    for (id, outcome) in &outcomes {
        match outcome {
            Outcome::Pending => invited.push(id.clone()),
            Outcome::New if created.contains(id) => invited.push(id.clone()),
            Outcome::New => skipped.push(json!({ "accountId": id, "reason": "limit" })),
            Outcome::Skipped(reason) => skipped.push(json!({ "accountId": id, "reason": reason })),
            Outcome::Contact => {}
        }
    }
    let mut lookup = invited.clone();
    lookup.extend(contacts.iter().cloned());
    let people = match people_by_id(pool, &lookup).await {
        Ok(people) => people,
        Err(error) => return db_error(error),
    };
    let shown = |ids: &[String]| -> Vec<Value> {
        ids.iter()
            .filter_map(|id| people.get(id).cloned())
            .collect()
    };
    (
        StatusCode::OK,
        Json(json!({
            "invited": shown(&invited),
            "added": shown(&contacts),
            "skipped": skipped,
        })),
    )
        .into_response()
}

/// Sorts each named account, in request order, without writing anything.
async fn classify(
    pool: &PgPool,
    group: &Group,
    viewer: &str,
    ids: &[String],
) -> sqlx_core::Result<Vec<(String, Outcome)>> {
    let members: Vec<(String,)> = query_as(
        "SELECT account_id FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND membership_state = 'active'",
    )
    .bind(group.conversation_id)
    .fetch_all(pool)
    .await?;
    let members: Vec<String> = members.into_iter().map(|(id,)| id).collect();
    let mut outcomes = Vec::with_capacity(ids.len());
    for id in ids {
        let outcome = if members.contains(id) {
            Outcome::Skipped("member")
        } else if !invitable(pool, viewer, id).await?
            || crate::safety::blocks::any_blocked(pool, id, &members).await?
        {
            // The same answer for every reason, naming nobody.
            Outcome::Skipped("unavailable")
        } else if is_contact(pool, viewer, id).await? {
            Outcome::Contact
        } else {
            let (pending, declined): (bool, bool) = query_as(&format!(
                "SELECT EXISTS (SELECT 1 FROM cloud_common_ground_group_invitations invite
                                WHERE invite.conversation_id = $1 AND invite.invitee_account_id = $2
                                  AND invite.status = 'pending' AND {LIVE_SQL}),
                        EXISTS (SELECT 1 FROM cloud_common_ground_group_invitations
                                WHERE conversation_id = $1 AND invitee_account_id = $2
                                  AND status = 'declined')"
            ))
            .bind(group.conversation_id)
            .bind(id)
            .fetch_one(pool)
            .await?;
            if pending {
                Outcome::Pending
            } else if declined {
                Outcome::Skipped("declined")
            } else {
                Outcome::New
            }
        };
        outcomes.push((id.clone(), outcome));
    }
    Ok(outcomes)
}

/// Creates pending invitations for `wanted` up to the inviter's cap, each
/// hinted to its invitee, and returns the ids now invited. A stale pending
/// invitation from someone who can no longer invite is withdrawn first.
async fn create(
    pool: &PgPool,
    group: &Group,
    viewer: &str,
    wanted: &[&String],
) -> sqlx_core::Result<HashSet<String>> {
    let mut created = HashSet::new();
    if wanted.is_empty() {
        return Ok(created);
    }
    let mut tx = pool.begin().await?;
    // One inviter's invitations are created one request at a time, so the
    // cap below holds under concurrent requests.
    query("SELECT pg_advisory_xact_lock(hashtext('common-ground-group-invite:' || $1))")
        .bind(viewer)
        .execute(&mut *tx)
        .await?;
    let (live,): (i64,) = query_as(&format!(
        "SELECT COUNT(*) FROM cloud_common_ground_group_invitations invite
         WHERE invite.inviter_account_id = $1 AND invite.status = 'pending' AND {LIVE_SQL}"
    ))
    .bind(viewer)
    .fetch_one(&mut *tx)
    .await?;
    let mut room = (MAX_PENDING - live).max(0);
    for id in wanted {
        query(&format!(
            "UPDATE cloud_common_ground_group_invitations invite
             SET status = 'withdrawn', decided_at = now()
             WHERE invite.conversation_id = $1 AND invite.invitee_account_id = $2
               AND invite.status = 'pending' AND NOT ({LIVE_SQL})"
        ))
        .bind(group.conversation_id)
        .bind(id.as_str())
        .execute(&mut *tx)
        .await?;
        let source: Option<(Uuid, String, chrono::DateTime<chrono::Utc>)> =
            query_as(&shared_room_sql("$1", "$2"))
                .bind(viewer)
                .bind(id.as_str())
                .fetch_optional(&mut *tx)
                .await?;
        if room == 0 {
            // A pending invitation from another admin still counts as invited.
            let (pending,): (bool,) = query_as(
                "SELECT EXISTS (SELECT 1 FROM cloud_common_ground_group_invitations
                                WHERE conversation_id = $1 AND invitee_account_id = $2
                                  AND status = 'pending')",
            )
            .bind(group.conversation_id)
            .bind(id.as_str())
            .fetch_one(&mut *tx)
            .await?;
            if pending {
                created.insert(id.to_string());
            }
            continue;
        }
        let inserted: Option<(Uuid,)> = query_as(
            "INSERT INTO cloud_common_ground_group_invitations
                 (invitation_id, conversation_id, group_space_id, inviter_account_id,
                  invitee_account_id, source_room_id, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending')
             ON CONFLICT (conversation_id, invitee_account_id) WHERE status = 'pending'
             DO NOTHING
             RETURNING invitation_id",
        )
        .bind(Uuid::new_v4())
        .bind(group.conversation_id)
        .bind(&group.space)
        .bind(viewer)
        .bind(id.as_str())
        .bind(source.map(|(room_id, _, _)| room_id))
        .fetch_optional(&mut *tx)
        .await?;
        if inserted.is_some() {
            room -= 1;
            hint(&mut tx, id, HINT, json!({})).await?;
        }
        // Either way a pending invitation to this group now exists.
        created.insert(id.to_string());
    }
    tx.commit().await?;
    Ok(created)
}
