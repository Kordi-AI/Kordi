//! What the invite flows read: the viewer's groups for one person (the
//! person page picker), the Grounding people the viewer can invite into one
//! group (Group › Add people), and the viewer's live invitations for
//! Contacts › Requests.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
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

use super::{
    admin_group, forbidden, group_people_preview, invitable_sql, shared_room_sql,
    FIRST_CHANNEL_SQL, LIVE_SQL, NAME_SQL,
};
use crate::auth::routes::CloudSession;
use crate::common_ground::actions::is_contact;
use crate::common_ground::actions::join_requests::APPROVER_SQL;
use crate::common_ground::db_error;
use crate::common_ground::people::{self as cg_people, person};
use crate::server::ServerState;

/// Groups the person picker shows, and people Add people shows.
const MAX_ROWS: i64 = 100;
/// People a picker row shows.
const PICKER_MEMBERS: usize = 4;
/// People an invitation in Contacts › Requests shows, as for a room one.
const INVITATION_MEMBERS: usize = 8;

/// Whether `viewer` may invite `other` into groups at all.
pub(super) async fn invitable<'e, E>(
    executor: E,
    viewer: &str,
    other: &str,
) -> sqlx_core::Result<bool>
where
    E: sqlx_core::executor::Executor<'e, Database = sqlx_postgres::Postgres>,
{
    if viewer == other
        || crate::system_account::service_account_ids()
            .iter()
            .any(|id| id == other)
    {
        return Ok(false);
    }
    let (invitable,): (bool,) = query_as(&format!(
        "SELECT EXISTS (SELECT 1 FROM cloud_accounts WHERE account_id = $2)
                AND {}",
        invitable_sql("$1", "$2")
    ))
    .bind(viewer)
    .bind(other)
    .fetch_one(executor)
    .await?;
    Ok(invitable)
}

type PickerRow = (Uuid, String, String, Option<String>);

/// `GET /v1/cloud/common-ground/people/:account_id/groups`: the groups the
/// viewer runs, newest activity first, with whether the person is already
/// in each one or invited.
pub(in crate::common_ground) async fn person_groups(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(account_id): Path<String>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let other = account_id.trim();
    match invitable(pool, viewer, other).await {
        Ok(true) => {}
        Ok(false) => return cg_people::not_found(),
        Err(error) => return db_error(error),
    }
    let contact = match is_contact(pool, viewer, other).await {
        Ok(contact) => contact,
        Err(error) => return db_error(error),
    };
    let rows: Result<Vec<PickerRow>, _> = query_as(&format!(
        "SELECT c.conversation_id, c.legacy_session_id, {NAME_SQL},
                CASE WHEN EXISTS (SELECT 1 FROM cloud_chat_conversation_members joined
                                  WHERE joined.conversation_id = c.conversation_id
                                    AND joined.account_id = $2
                                    AND joined.membership_state = 'active') THEN 'member'
                     WHEN EXISTS (SELECT 1 FROM cloud_common_ground_group_invitations invite
                                  WHERE invite.conversation_id = c.conversation_id
                                    AND invite.invitee_account_id = $2
                                    AND invite.status = 'pending' AND {LIVE_SQL}) THEN 'invited'
                END
         FROM cloud_chat_conversation_members member
         JOIN cloud_chat_conversations c ON c.conversation_id = member.conversation_id
         LEFT JOIN cloud_common_ground_room_groups room_group
           ON room_group.conversation_id = c.conversation_id
         WHERE member.account_id = $1 AND {APPROVER_SQL}
           AND c.kind = 'group' AND c.legacy_session_id IS NOT NULL AND {FIRST_CHANNEL_SQL}
         ORDER BY c.updated_at DESC, c.conversation_id
         LIMIT {MAX_ROWS}"
    ))
    .bind(viewer)
    .bind(other)
    .fetch_all(pool)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return db_error(error),
    };
    let conversations: Vec<Uuid> = rows.iter().map(|row| row.0).collect();
    let (mut members, counts) =
        match group_people_preview(pool, &conversations, PICKER_MEMBERS).await {
            Ok(preview) => preview,
            Err(error) => return db_error(error),
        };
    let groups: Vec<Value> = rows
        .into_iter()
        .map(|(conversation, space, name, state)| {
            json!({
                "groupSpaceId": space,
                "conversationId": conversation,
                "name": name,
                "memberCount": counts.get(&conversation).copied().unwrap_or(0),
                "members": members.remove(&conversation).unwrap_or_default(),
                "state": state,
            })
        })
        .collect();
    (
        StatusCode::OK,
        Json(json!({ "contact": contact, "groups": groups })),
    )
        .into_response()
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(in crate::common_ground) struct GroupQuery {
    group_space_id: String,
}

type PersonRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
);

/// `GET /v1/cloud/common-ground/group-people?groupSpaceId=…`: the Grounding
/// people the viewer can invite into this group who are not their contacts
/// and not in it yet. People from rooms come first, most recent room first,
/// with the room's name as `source`; people from a match or pairing follow
/// with a null `source`.
pub(in crate::common_ground) async fn group_people(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Query(params): Query<GroupQuery>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let group = match admin_group(pool, &params.group_space_id, viewer).await {
        Ok(Some(group)) => group,
        Ok(None) => return forbidden(),
        Err(error) => return db_error(error),
    };
    let rows: Result<Vec<PersonRow>, _> = query_as(&format!(
        "WITH candidates AS (
             SELECT theirs.account_id AS other FROM cloud_common_ground_room_members mine
             JOIN cloud_common_ground_room_members theirs
               ON theirs.room_id = mine.room_id AND theirs.left_at IS NULL
             WHERE mine.account_id = $1 AND mine.left_at IS NULL
             UNION SELECT other_account_id FROM cloud_common_ground_matches
             WHERE viewer_account_id = $1 AND opened_at IS NOT NULL
             UNION SELECT CASE WHEN account_a = $1 THEN account_b ELSE account_a END
             FROM cloud_common_ground_pairings WHERE account_a = $1 OR account_b = $1
         )
         SELECT account.account_id, account.display_name,
                COALESCE(account.public_handle, account.public_account_number::TEXT),
                account.avatar_url, source.room_name,
                EXISTS (SELECT 1 FROM cloud_common_ground_group_invitations invite
                        WHERE invite.conversation_id = $2
                          AND invite.invitee_account_id = account.account_id
                          AND invite.status = 'pending' AND {LIVE_SQL})
         FROM candidates
         JOIN cloud_accounts account ON account.account_id = candidates.other
         LEFT JOIN LATERAL ({shared_room}) source(room_id, room_name, at) ON true
         LEFT JOIN LATERAL (
             SELECT GREATEST(
                 (SELECT max(opened_at) FROM cloud_common_ground_matches
                  WHERE viewer_account_id = $1 AND other_account_id = account.account_id),
                 (SELECT max(created_at) FROM cloud_common_ground_pairings
                  WHERE account_a = LEAST($1, account.account_id)
                    AND account_b = GREATEST($1, account.account_id))) AS at
         ) linked ON true
         WHERE candidates.other <> $1 AND NOT (candidates.other = ANY($3))
           AND {invitable}
           AND NOT EXISTS (SELECT 1 FROM cloud_contacts
                           WHERE account_id = $1 AND peer_account_id = candidates.other)
           AND NOT EXISTS (SELECT 1 FROM cloud_chat_conversation_members joined
                           WHERE joined.conversation_id = $2
                             AND joined.account_id = candidates.other
                             AND joined.membership_state = 'active')
           AND NOT EXISTS (SELECT 1 FROM cloud_chat_conversation_members member
                           WHERE member.conversation_id = $2
                             AND member.membership_state = 'active'
                             AND cloud_accounts_blocked_either_way(member.account_id,
                                                                   candidates.other))
         ORDER BY source.room_name IS NULL, source.at DESC NULLS LAST, linked.at DESC NULLS LAST,
                  lower(COALESCE(account.display_name, '')), account.account_id
         LIMIT {MAX_ROWS}",
        shared_room = shared_room_sql("$1", "account.account_id"),
        invitable = invitable_sql("$1", "candidates.other"),
    ))
    .bind(viewer)
    .bind(group.conversation_id)
    .bind(crate::system_account::service_account_ids())
    .fetch_all(pool)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return db_error(error),
    };
    let people: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, handle, avatar, source, invited)| {
            json!({
                "person": person(&id, name.as_deref(), handle.as_deref(), avatar.as_deref()),
                "source": source,
                "invited": invited,
            })
        })
        .collect();
    (StatusCode::OK, Json(json!({ "people": people }))).into_response()
}

type InvitationRow = (
    Uuid,
    Option<String>,
    String,
    Uuid,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    DateTime<Utc>,
);

/// The viewer's live group invitations from people, newest first, as
/// `(createdAt, groupSpaceId, invitation)` in the shape of a room
/// invitation with `kind` "group" and a null `code`. Invitations from
/// someone the viewer now blocks, or who blocks them, are left out.
pub(in crate::common_ground::actions) async fn pending_group_invitations(
    pool: &PgPool,
    viewer: &str,
) -> sqlx_core::Result<Vec<(DateTime<Utc>, String, Value)>> {
    let rows: Vec<InvitationRow> = query_as(&format!(
        "SELECT invite.invitation_id, room.name, invite.group_space_id, invite.conversation_id,
                {NAME_SQL}, invite.inviter_account_id, account.display_name,
                COALESCE(account.public_handle, account.public_account_number::TEXT),
                account.avatar_url, invite.created_at
         FROM cloud_common_ground_group_invitations invite
         JOIN cloud_chat_conversations c ON c.conversation_id = invite.conversation_id
         LEFT JOIN cloud_common_ground_room_groups room_group
           ON room_group.conversation_id = c.conversation_id
         LEFT JOIN cloud_common_ground_rooms room ON room.room_id = invite.source_room_id
         JOIN cloud_accounts account ON account.account_id = invite.inviter_account_id
         WHERE invite.invitee_account_id = $1 AND invite.status = 'pending' AND {LIVE_SQL}
           AND NOT cloud_accounts_blocked_either_way($1, invite.inviter_account_id)
         ORDER BY invite.created_at DESC, invite.invitation_id"
    ))
    .bind(viewer)
    .fetch_all(pool)
    .await?;
    let conversations: Vec<Uuid> = rows.iter().map(|row| row.3).collect();
    let (mut members, counts) =
        group_people_preview(pool, &conversations, INVITATION_MEMBERS).await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                invitation_id,
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
                let invitation = json!({
                    "kind": "group",
                    "invitationRef": invitation_id,
                    "code": Value::Null,
                    "roomName": room_name,
                    "groupSpaceId": space,
                    "conversationId": conversation,
                    "name": name,
                    "members": members.remove(&conversation).unwrap_or_default(),
                    "memberCount": counts.get(&conversation).copied().unwrap_or(0),
                    "from": person(&from, from_name.as_deref(), from_handle.as_deref(), avatar.as_deref()),
                    "createdAt": created_at,
                });
                (created_at, space, invitation)
            },
        )
        .collect())
}
