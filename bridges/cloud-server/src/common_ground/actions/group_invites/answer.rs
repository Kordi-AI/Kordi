//! Answering: the invitee joins or declines a group invitation from a
//! person. Declining is quiet: the inviter is not told.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::json;
use sqlx_core::{query::query, query_as::query_as, transaction::Transaction};
use sqlx_postgres::Postgres;
use uuid::Uuid;

use super::{invitation_not_found, HINT, NAME_SQL};
use crate::auth::routes::{write_audit, CloudSession};
use crate::chat_sync::store::{accept_invited_conversation_member, StoreError};
use crate::common_ground::actions::join_requests::can_decide;
use crate::common_ground::{db_error, err, hint, intro};
use crate::server::ServerState;
use crate::system_account::SYSTEM_ACCOUNT_ID;

/// A stored invitation with its group.
struct Invitation {
    id: Uuid,
    conversation_id: Uuid,
    space: String,
    inviter: String,
    invitee: String,
    source_room_id: Option<Uuid>,
    status: String,
    name: String,
    room_group: bool,
}

type InvitationRow = (
    Uuid,
    Uuid,
    String,
    String,
    String,
    Option<Uuid>,
    String,
    String,
    bool,
);

/// The invitation with this id, its row locked until `tx` ends.
async fn lock(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> sqlx_core::Result<Option<Invitation>> {
    let row: Option<InvitationRow> = query_as(&format!(
        "SELECT invite.invitation_id, invite.conversation_id, invite.group_space_id,
                invite.inviter_account_id, invite.invitee_account_id, invite.source_room_id,
                invite.status, {NAME_SQL}, room_group.group_space_id IS NOT NULL
         FROM cloud_common_ground_group_invitations invite
         JOIN cloud_chat_conversations c ON c.conversation_id = invite.conversation_id
         LEFT JOIN cloud_common_ground_room_groups room_group
           ON room_group.conversation_id = c.conversation_id
         WHERE invite.invitation_id = $1
         FOR UPDATE OF invite"
    ))
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.map(
        |(
            id,
            conversation_id,
            space,
            inviter,
            invitee,
            source_room_id,
            status,
            name,
            room_group,
        )| Invitation {
            id,
            conversation_id,
            space,
            inviter,
            invitee,
            source_room_id,
            status,
            name,
            room_group,
        },
    ))
}

async fn mark(tx: &mut Transaction<'_, Postgres>, id: Uuid, status: &str) -> sqlx_core::Result<()> {
    query(
        "UPDATE cloud_common_ground_group_invitations
         SET status = $2, decided_at = now()
         WHERE invitation_id = $1 AND status = 'pending'",
    )
    .bind(id)
    .bind(status)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn no_longer_available() -> Response {
    err(
        "common_ground_invitation_not_found",
        "This invitation is no longer available.",
        StatusCode::NOT_FOUND,
    )
}

fn failed(error: impl std::fmt::Debug) -> Response {
    eprintln!("[common-ground] Could not accept a group invitation: {error:?}");
    err(
        "common_ground_failed",
        "Could not join. Try again.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

/// What the join transaction did.
enum Joined {
    Now,
    Already,
}

/// `POST /v1/cloud/common-ground/group-invitations/:invitation_id/join`.
pub(in crate::common_ground) async fn join_group_invitation(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(invitation_id): Path<String>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let Ok(id) = invitation_id.trim().parse::<Uuid>() else {
        return invitation_not_found();
    };
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(error) => return db_error(error),
    };
    let invitation = match lock(&mut tx, id).await {
        Ok(Some(invitation)) if invitation.invitee == viewer => invitation,
        Ok(_) => return invitation_not_found(),
        Err(error) => return db_error(error),
    };
    let joined = match join_in(&mut tx, &invitation).await {
        Ok(Ok(joined)) => joined,
        Ok(Err(response)) => {
            // A withdrawn invitation is committed before answering.
            if let Err(error) = tx.commit().await {
                return db_error(error);
            }
            return *response;
        }
        Err(error) => return failed(error),
    };
    if let Err(error) = tx.commit().await {
        return db_error(error);
    }
    let status = match joined {
        Joined::Already => "already_joined",
        Joined::Now => {
            after_join(&state, &invitation).await;
            "joined"
        }
    };
    (
        StatusCode::OK,
        Json(json!({
            "status": status,
            "groupSpaceId": invitation.space,
            "conversationId": invitation.conversation_id,
            "name": invitation.name,
        })),
    )
        .into_response()
}

/// The join inside `tx` with the invitation locked: what it did, or the
/// response to send instead. Only a withdrawal is written before such a
/// response; every other refusal changes nothing.
async fn join_in(
    tx: &mut Transaction<'_, Postgres>,
    invitation: &Invitation,
) -> Result<Result<Joined, Box<Response>>, StoreError> {
    match invitation.status.as_str() {
        "accepted" => return Ok(Ok(Joined::Already)),
        "pending" => {}
        _ => return Ok(Err(Box::new(invitation_not_found()))),
    }
    let viewer = invitation.invitee.as_str();
    let members: Vec<(String,)> = query_as(
        "SELECT account_id FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND membership_state = 'active'",
    )
    .bind(invitation.conversation_id)
    .fetch_all(&mut **tx)
    .await?;
    let members: Vec<String> = members.into_iter().map(|(id,)| id).collect();
    if members.iter().any(|id| id == viewer) {
        mark(tx, invitation.id, "accepted").await?;
        hint(tx, viewer, HINT, json!({})).await?;
        return Ok(Ok(Joined::Already));
    }
    if !can_decide(&mut **tx, invitation.conversation_id, &invitation.inviter).await? {
        mark(tx, invitation.id, "withdrawn").await?;
        hint(tx, viewer, HINT, json!({})).await?;
        return Ok(Err(Box::new(no_longer_available())));
    }
    if crate::safety::blocks::any_blocked(&mut **tx, viewer, &members).await? {
        // The same refusal for either direction, naming nobody.
        return Ok(Err(Box::new(err(
            "common_ground_invitation_unavailable",
            "You can't join this group.",
            StatusCode::BAD_REQUEST,
        ))));
    }
    match accept_invited_conversation_member(tx, &invitation.inviter, &invitation.space, viewer)
        .await
    {
        Ok(_) => {}
        Err(StoreError::InvalidInput("group member count is invalid")) => {
            return Ok(Err(Box::new(err(
                "common_ground_group_full",
                "This group is full.",
                StatusCode::CONFLICT,
            ))));
        }
        Err(error) => return Err(error),
    }
    mark(tx, invitation.id, "accepted").await?;
    hint(tx, viewer, HINT, json!({})).await?;
    Ok(Ok(Joined::Now))
}

/// After a new join: the audit event and, in a group started from a room,
/// System's joined line when the invitation came through a room.
async fn after_join(state: &Arc<ServerState>, invitation: &Invitation) {
    let pool = state.db_pool();
    let _ = write_audit(
        pool,
        Some(&invitation.invitee),
        None,
        "group.invitation.accepted",
        json!({
            "common_ground_group_invitation_id": invitation.id,
            "group_space_id": invitation.space,
            "invited_by": invitation.inviter,
        }),
    )
    .await;
    let Some(room_id) = invitation.source_room_id.filter(|_| invitation.room_group) else {
        return;
    };
    let posted = match crate::system_account::join(pool, invitation.conversation_id).await {
        Ok(_) => intro::post_joined(
            pool,
            SYSTEM_ACCOUNT_ID,
            room_id,
            invitation.conversation_id,
            &invitation.invitee,
        )
        .await
        .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    if let Err(error) = posted {
        eprintln!("[common-ground] Could not post a joined line: {error}");
    }
}

/// `POST /v1/cloud/common-ground/group-invitations/:invitation_id/decline`:
/// the invitee declines. Declining again, or an invitation that is no
/// longer pending, changes nothing.
pub(in crate::common_ground) async fn decline_group_invitation(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(invitation_id): Path<String>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let Ok(id) = invitation_id.trim().parse::<Uuid>() else {
        return invitation_not_found();
    };
    let result = async {
        let mut tx = pool.begin().await?;
        let found: Option<(String,)> = query_as(
            "SELECT status FROM cloud_common_ground_group_invitations
             WHERE invitation_id = $1 AND invitee_account_id = $2
             FOR UPDATE",
        )
        .bind(id)
        .bind(viewer)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((status,)) = found else {
            return Ok(false);
        };
        if status == "pending" {
            mark(&mut tx, id, "declined").await?;
            // The invitee's other devices drop it from Requests.
            hint(&mut tx, viewer, HINT, json!({})).await?;
        }
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(true)
    }
    .await;
    match result {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => invitation_not_found(),
        Err(error) => db_error(error),
    }
}
