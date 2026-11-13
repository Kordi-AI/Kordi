//! Approving a request to join: the requester joins through the group's
//! invitation link exactly as an invited room member does, with the same
//! room invitation bookkeeping, audit event and joined line.

use std::sync::Arc;

use axum::{http::StatusCode, response::Response};
use serde_json::json;
use sqlx_core::{query::query, query_as::query_as, transaction::Transaction};
use sqlx_postgres::Postgres;
use uuid::Uuid;

use super::{
    closed, is_active_member, lock_for_decision, mark_decided, respond, sync_card, JoinRequest,
    APPROVER_SQL,
};
use crate::auth::routes::{
    group_invitation_link_in_transaction, redeem_group_invitation_by_id, write_audit, LinkOutcome,
    LinkRequest, Redemption, ROOM_GROUP_MIN_MEMBERS,
};
use crate::common_ground::{db_error, err, intro, rooms};
use crate::server::ServerState;
use crate::system_account::SYSTEM_ACCOUNT_ID;

fn failed(error: impl std::fmt::Display) -> Response {
    eprintln!("[common-ground] Could not approve a join request: {error}");
    err(
        "common_ground_failed",
        "Could not add them. Try again.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

/// What the approval transaction did.
enum Approved {
    /// The requester joined now; carries the group invitation used.
    Joined(String),
    /// The requester was already in the group.
    AlreadyMember,
    /// The requester left the room, so the request was withdrawn.
    LeftRoom,
}

/// The group's invitation link, made or renewed by `approver` or, when they
/// may not invite, by another approver.
async fn invitation_link(
    tx: &mut Transaction<'_, Postgres>,
    request: &JoinRequest,
    approver: &str,
) -> sqlx_core::Result<Option<String>> {
    let others: Vec<(String,)> = query_as(&format!(
        "SELECT member.account_id FROM cloud_chat_conversation_members member
         WHERE member.conversation_id = $1 AND {APPROVER_SQL} AND member.account_id <> $2
           AND NOT (member.account_id = ANY($3))
         ORDER BY member.role = 'owner' DESC, member.joined_at, member.account_id"
    ))
    .bind(request.conversation_id)
    .bind(approver)
    .bind(crate::system_account::service_account_ids())
    .fetch_all(&mut **tx)
    .await?;
    let inviters = std::iter::once(approver.to_string()).chain(others.into_iter().map(|(id,)| id));
    for inviter in inviters {
        let outcome = group_invitation_link_in_transaction(
            tx,
            &inviter,
            &request.group_space_id,
            &request.group_space_id,
            &request.group_name,
            ROOM_GROUP_MIN_MEMBERS,
            LinkRequest::CurrentOrNew,
        )
        .await?;
        if let LinkOutcome::Link(link) = outcome {
            return Ok(Some(link.invitation_id));
        }
    }
    Ok(None)
}

/// Points the requester's room invitation to this group at `invitation_id`,
/// from `approver`, and returns its reference.
async fn room_invitation(
    tx: &mut Transaction<'_, Postgres>,
    request: &JoinRequest,
    invitation_id: &str,
    approver: &str,
) -> sqlx_core::Result<String> {
    let (reference,): (String,) = query_as(
        "INSERT INTO cloud_common_ground_room_invitations
             (invitation_ref, room_id, group_space_id, group_invitation_id,
              inviter_account_id, invitee_account_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (group_space_id, invitee_account_id) DO UPDATE
         SET group_invitation_id = EXCLUDED.group_invitation_id,
             inviter_account_id = EXCLUDED.inviter_account_id,
             accepted_at = NULL
         RETURNING invitation_ref",
    )
    .bind(format!("cgi_{}", Uuid::new_v4().simple()))
    .bind(request.room_id)
    .bind(&request.group_space_id)
    .bind(invitation_id)
    .bind(approver)
    .bind(&request.requester)
    .fetch_one(&mut **tx)
    .await?;
    Ok(reference)
}

/// Approves a pending request by `approver`, who must be allowed to decide.
pub(super) async fn approve(
    state: &Arc<ServerState>,
    request_id: Uuid,
    approver: &str,
) -> Response {
    let pool = state.db_pool();
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(error) => return db_error(error),
    };
    let mut request = match lock_for_decision(pool, &mut tx, request_id, approver).await {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let approved = match approve_in(&mut tx, &mut request, approver).await {
        Ok(Ok(approved)) => approved,
        Ok(Err(response)) => return *response,
        Err(error) => return failed(error),
    };
    let finished = async {
        rooms::notify_members(&mut tx, request.room_id, &request.code).await?;
        tx.commit().await
    }
    .await;
    if let Err(error) = finished {
        return db_error(error);
    }
    sync_card(pool, &request).await;
    match approved {
        Approved::LeftRoom => return closed(pool, &request).await,
        Approved::AlreadyMember => {}
        Approved::Joined(invitation_id) => {
            // Recorded for the requester, as when they accept an invitation
            // themselves; the approver is named in the metadata.
            let _ = write_audit(
                pool,
                Some(&request.requester),
                None,
                "group.invitation.accepted",
                json!({
                    "invitation_id": invitation_id,
                    "group_space_id": request.group_space_id,
                    "join_request_id": request.request_id,
                    "approved_by": approver,
                }),
            )
            .await;
            let posted = match crate::system_account::join(pool, request.conversation_id).await {
                Ok(_) => intro::post_joined(
                    pool,
                    SYSTEM_ACCOUNT_ID,
                    request.room_id,
                    request.conversation_id,
                    &request.requester,
                )
                .await
                .map_err(|error| error.to_string()),
                Err(error) => Err(error.to_string()),
            };
            if let Err(error) = posted {
                eprintln!("[common-ground] Could not post a joined line: {error}");
            }
        }
    }
    respond(pool, StatusCode::OK, &request).await
}

/// The approval inside `tx` with the request locked: what it did, or the
/// response to send instead (nothing is committed then).
async fn approve_in(
    tx: &mut Transaction<'_, Postgres>,
    request: &mut JoinRequest,
    approver: &str,
) -> sqlx_core::Result<Result<Approved, Box<Response>>> {
    if is_active_member(&mut **tx, request.conversation_id, &request.requester).await? {
        mark_decided(tx, request, "approved", approver).await?;
        return Ok(Ok(Approved::AlreadyMember));
    }
    let (in_room,): (bool,) = query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_common_ground_room_members
                        WHERE room_id = $1 AND account_id = $2 AND left_at IS NULL)",
    )
    .bind(request.room_id)
    .bind(&request.requester)
    .fetch_one(&mut **tx)
    .await?;
    if !in_room {
        query(
            "UPDATE cloud_common_ground_room_join_requests
             SET status = 'cancelled', revision = revision + 1, decided_at = now()
             WHERE request_id = $1",
        )
        .bind(request.request_id)
        .execute(&mut **tx)
        .await?;
        request.status = "cancelled".to_string();
        request.revision += 1;
        return Ok(Ok(Approved::LeftRoom));
    }
    let members: Vec<(String,)> = query_as(
        "SELECT account_id FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND membership_state = 'active'",
    )
    .bind(request.conversation_id)
    .fetch_all(&mut **tx)
    .await?;
    let members: Vec<String> = members.into_iter().map(|(id,)| id).collect();
    if crate::safety::blocks::any_blocked(&mut **tx, &request.requester, &members).await? {
        // The same refusal for either direction, naming nobody.
        return Ok(Err(Box::new(err(
            "common_ground_join_request_unavailable",
            "This person can't join this group.",
            StatusCode::BAD_REQUEST,
        ))));
    }
    let Some(invitation_id) = invitation_link(tx, request, approver).await? else {
        return Ok(Err(Box::new(failed("no approver may invite to the group"))));
    };
    let reference = room_invitation(tx, request, &invitation_id, approver).await?;
    let redeemed = redeem_group_invitation_by_id(
        tx,
        &invitation_id,
        &request.requester,
        ROOM_GROUP_MIN_MEMBERS,
    )
    .await;
    match redeemed {
        Redemption::Done(_) => {}
        Redemption::Failed(_, response) => return Ok(Err(Box::new(response))),
    }
    // A person who once joined through this link and later left the group
    // counts as already joined there, without being added again, so the
    // approver adds them back the way the link adds a new member.
    if !is_active_member(&mut **tx, request.conversation_id, &request.requester).await? {
        crate::chat_sync::store::accept_invited_conversation_member(
            tx,
            approver,
            &request.group_space_id,
            &request.requester,
        )
        .await
        .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
        if !is_active_member(&mut **tx, request.conversation_id, &request.requester).await? {
            return Ok(Err(Box::new(failed(
                "the requester could not be added back to the group",
            ))));
        }
    }
    query(
        "UPDATE cloud_common_ground_room_invitations SET accepted_at = now()
         WHERE invitation_ref = $1",
    )
    .bind(&reference)
    .execute(&mut **tx)
    .await?;
    mark_decided(tx, request, "approved", approver).await?;
    Ok(Ok(Approved::Joined(invitation_id)))
}
