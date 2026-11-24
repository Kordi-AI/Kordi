//! Resolve a room topic to its oldest open group, including pre-existing groups.
use std::sync::Arc;

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use sqlx_core::{query::query, query_as::query_as, transaction::Transaction};
use sqlx_postgres::Postgres;
use uuid::Uuid;

use crate::{
    auth::routes::CloudSession,
    common_ground::{actions::join::join_room_invitation, db_error, err},
    server::ServerState,
};

pub(super) struct TopicGroup {
    space: String,
    conversation: Uuid,
    name: String,
    invitation: Option<String>,
}

pub(super) async fn lock_and_find(
    tx: &mut Transaction<'_, Postgres>,
    room: Uuid,
    topic: &str,
    viewer: &str,
) -> sqlx_core::Result<Option<TopicGroup>> {
    // The lookup must be a separate statement so its snapshot sees a competing creator's commit.
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("common-ground:topic:{room}:{topic}"))
        .execute(&mut **tx)
        .await?;
    let row: Option<(String, Uuid, String, Option<String>)> = query_as(
        "SELECT g.group_space_id, g.conversation_id, g.name, invite.invitation_ref
         FROM cloud_common_ground_room_groups g
         JOIN cloud_chat_conversations c ON c.conversation_id = g.conversation_id
         LEFT JOIN cloud_common_ground_room_invitations invite
           ON invite.group_space_id = g.group_space_id AND invite.invitee_account_id = $3
          AND invite.accepted_at IS NULL AND invite.declined_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM cloud_chat_conversation_members m
                          WHERE m.conversation_id = g.conversation_id AND m.account_id = $3
                            AND m.membership_state = 'active')
         WHERE g.room_id = $1 AND g.topic = $2 AND c.closed_at IS NULL
         ORDER BY g.created_at, g.group_space_id LIMIT 1",
    )
    .bind(room)
    .bind(topic)
    .bind(viewer)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(
        row.map(|(space, conversation, name, invitation)| TopicGroup {
            space,
            conversation,
            name,
            invitation,
        }),
    )
}

impl TopicGroup {
    pub(super) async fn open(
        self,
        state: &Arc<ServerState>,
        session: &CloudSession,
        room: Uuid,
        code: &str,
        topic: &str,
    ) -> Response {
        if let Some(reference) = self.invitation {
            let joined = join_room_invitation(state, session, room, code, &reference).await;
            if !joined.status().is_success() {
                return joined;
            }
        }
        // A matching topic is not permission to enter a group.
        let members: sqlx_core::Result<Option<(i64,)>> = query_as(
            "SELECT COUNT(*) FROM cloud_chat_conversation_members
             WHERE conversation_id = $1 AND membership_state = 'active' AND NOT (account_id = ANY($2))
             HAVING bool_or(account_id = $3)",
        )
        .bind(self.conversation)
        .bind(crate::system_account::service_account_ids())
        .bind(&session.account_id)
        .fetch_optional(state.db_pool())
        .await;
        match members {
            Ok(Some((count,))) => Json(json!({
                "group": {"groupSpaceId": self.space, "conversationId": self.conversation,
                          "name": self.name, "topic": topic, "memberCount": count},
                "added": [], "invited": []
            }))
            .into_response(),
            Ok(None) => err(
                "common_ground_group_exists",
                "This group already exists. See its joining options in the room.",
                StatusCode::CONFLICT,
            ),
            Err(error) => db_error(error),
        }
    }
}
