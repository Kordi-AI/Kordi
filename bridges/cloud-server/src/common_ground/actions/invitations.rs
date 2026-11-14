//! Room group invitations outside the room: the viewer's pending ones across
//! rooms, listed in Contacts › Requests, and declining one.

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
use uuid::Uuid;

use crate::auth::routes::CloudSession;
use crate::common_ground::people::person;
use crate::common_ground::{db_error, err, hint, rooms};
use crate::server::ServerState;

type PendingRow = (
    String,
    String,
    String,
    String,
    Uuid,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    DateTime<Utc>,
);

/// `GET /v1/cloud/common-ground/invitations`: room group invitations the
/// viewer has not answered, newest first. Only rooms the viewer is still in
/// count, and only groups they are not already in, through a live link.
pub(in crate::common_ground) async fn pending(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let pool = state.db_pool();
    // Group invitations keep their expiry as RFC 3339 text in UTC.
    let rows: Result<Vec<PendingRow>, _> = query_as(
        "SELECT invite.invitation_ref, room.code, room.name, invite.group_space_id,
                room_group.conversation_id, room_group.name, invite.inviter_account_id,
                account.display_name,
                COALESCE(account.public_handle, account.public_account_number::TEXT),
                account.avatar_url, invite.created_at
         FROM cloud_common_ground_room_invitations invite
         JOIN cloud_common_ground_rooms room ON room.room_id = invite.room_id
         JOIN cloud_common_ground_room_members member
           ON member.room_id = invite.room_id AND member.account_id = invite.invitee_account_id
          AND member.left_at IS NULL
         JOIN cloud_common_ground_room_groups room_group
           ON room_group.group_space_id = invite.group_space_id
         JOIN cloud_group_invitations group_invite
           ON group_invite.invitation_id = invite.group_invitation_id
         JOIN cloud_accounts account ON account.account_id = invite.inviter_account_id
         WHERE invite.invitee_account_id = $1
           AND invite.accepted_at IS NULL AND invite.declined_at IS NULL
           AND group_invite.revoked_at IS NULL AND group_invite.expires_at > $2
           AND NOT EXISTS (SELECT 1 FROM cloud_chat_conversation_members joined
                           WHERE joined.conversation_id = room_group.conversation_id
                             AND joined.account_id = $1 AND joined.membership_state = 'active')
         ORDER BY invite.created_at DESC, invite.invitation_ref",
    )
    .bind(&session.account_id)
    .bind(Utc::now().to_rfc3339())
    .fetch_all(pool)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return db_error(error),
    };
    let invitations: Vec<_> = rows
        .into_iter()
        .map(
            |(
                reference,
                code,
                room_name,
                space,
                conversation,
                name,
                from,
                from_name,
                from_handle,
                avatar,
                created_at,
            )| {
                json!({
                    "invitationRef": reference,
                    "code": code,
                    "roomName": room_name,
                    "groupSpaceId": space,
                    "conversationId": conversation,
                    "name": name,
                    "from": person(&from, from_name.as_deref(), from_handle.as_deref(), avatar.as_deref()),
                    "createdAt": created_at,
                })
            },
        )
        .collect();
    (StatusCode::OK, Json(json!({ "invitations": invitations }))).into_response()
}

/// `POST /v1/cloud/common-ground/rooms/:code/invitations/:ref/decline`: the
/// invitee declines. Declining again, or after joining, changes nothing.
pub(in crate::common_ground) async fn decline(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((code, invitation_ref)): Path<(String, String)>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let room_id = match rooms::my_room(pool, &code, viewer).await {
        Ok(Some((room_id, _))) => room_id,
        Ok(None) => return rooms::room_not_found(),
        Err(error) => return db_error(error),
    };
    let result = async {
        let mut tx = pool.begin().await?;
        let found: Option<(bool,)> = query_as(
            "UPDATE cloud_common_ground_room_invitations
             SET declined_at = COALESCE(declined_at, now())
             WHERE invitation_ref = $1 AND room_id = $2 AND invitee_account_id = $3
             RETURNING accepted_at IS NULL",
        )
        .bind(&invitation_ref)
        .bind(room_id)
        .bind(viewer)
        .fetch_optional(&mut *tx)
        .await?;
        if found.is_some() {
            // The invitee's other devices drop it from the room and Requests.
            hint(
                &mut tx,
                viewer,
                "common_ground.room.updated",
                json!({ "code": code }),
            )
            .await?;
        }
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(found.is_some())
    }
    .await;
    match result {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => err(
            "common_ground_invitation_not_found",
            "Invitation not found.",
            StatusCode::NOT_FOUND,
        ),
        Err(error) => db_error(error),
    }
}
