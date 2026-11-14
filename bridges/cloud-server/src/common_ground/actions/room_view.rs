//! Groups started from a room and the viewer's pending invitations to them,
//! shown with the room and its results.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::join_requests::APPROVER_SQL;
use crate::common_ground::people::person;
use crate::common_ground::ROOM_OPEN_SQL;

type GroupRow = (
    String,
    Uuid,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    bool,
);

/// People a group row shows.
const MAX_SHOWN_MEMBERS: usize = 8;

/// The active people in each conversation, creator first, then by join
/// order, at most [`MAX_SHOWN_MEMBERS`] each. Service accounts are left out.
pub(in crate::common_ground) async fn group_members(
    pool: &PgPool,
    conversations: &[Uuid],
    service: &[String],
) -> sqlx_core::Result<HashMap<Uuid, Vec<Value>>> {
    type MemberRow = (Uuid, String, Option<String>, Option<String>, Option<String>);
    let rows: Vec<MemberRow> = query_as(
        "SELECT member.conversation_id, member.account_id, account.display_name,
                COALESCE(account.public_handle, account.public_account_number::TEXT), account.avatar_url
         FROM cloud_chat_conversation_members member
         JOIN cloud_accounts account ON account.account_id = member.account_id
         JOIN cloud_common_ground_room_groups room_group
           ON room_group.conversation_id = member.conversation_id
         WHERE member.conversation_id = ANY($1) AND member.membership_state = 'active'
           AND NOT (member.account_id = ANY($2))
         ORDER BY member.conversation_id, member.account_id = room_group.created_by DESC,
                  member.joined_at, member.account_id",
    )
    .bind(conversations)
    .bind(service)
    .fetch_all(pool)
    .await?;
    let mut out: HashMap<Uuid, Vec<Value>> = HashMap::new();
    for (conversation, account, name, handle, avatar) in rows {
        let shown = out.entry(conversation).or_default();
        if shown.len() < MAX_SHOWN_MEMBERS {
            shown.push(person(
                &account,
                name.as_deref(),
                handle.as_deref(),
                avatar.as_deref(),
            ));
        }
    }
    Ok(out)
}

type InvitationRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    DateTime<Utc>,
);

/// `viewer`'s live, unaccepted invitations to groups started in this room,
/// newest first.
async fn invitations(pool: &PgPool, room_id: Uuid, viewer: &str) -> sqlx_core::Result<Vec<Value>> {
    // Group invitations keep their expiry as RFC 3339 text in UTC.
    let invitations: Vec<InvitationRow> = query_as(
        "SELECT invite.invitation_ref, invite.group_space_id, room_group.name,
                invite.inviter_account_id, account.display_name, COALESCE(account.public_handle, account.public_account_number::TEXT), account.avatar_url,
                invite.created_at
         FROM cloud_common_ground_room_invitations invite
         JOIN cloud_common_ground_room_groups room_group
           ON room_group.group_space_id = invite.group_space_id
         JOIN cloud_group_invitations group_invite
           ON group_invite.invitation_id = invite.group_invitation_id
         JOIN cloud_accounts account ON account.account_id = invite.inviter_account_id
         WHERE invite.room_id = $1 AND invite.invitee_account_id = $2
           AND invite.accepted_at IS NULL AND invite.declined_at IS NULL
           AND group_invite.revoked_at IS NULL AND group_invite.expires_at > $3
         ORDER BY invite.created_at DESC",
    )
    .bind(room_id)
    .bind(viewer)
    .bind(Utc::now().to_rfc3339())
    .fetch_all(pool)
    .await?;
    Ok(invitations
        .into_iter()
        .map(
            |(reference, space, name, from, from_name, from_handle, avatar, created_at)| {
                json!({
                    "invitationRef": reference,
                    "groupSpaceId": space,
                    "name": name,
                    "from": person(
                        &from,
                        from_name.as_deref(),
                        from_handle.as_deref(),
                        avatar.as_deref(),
                    ),
                    "createdAt": created_at,
                })
            },
        )
        .collect())
}

async fn room_open(pool: &PgPool, room_id: Uuid) -> sqlx_core::Result<bool> {
    let (open,): (bool,) = query_as(&format!(
        "SELECT {ROOM_OPEN_SQL} FROM cloud_common_ground_rooms room WHERE room.room_id = $1"
    ))
    .bind(room_id)
    .fetch_one(pool)
    .await?;
    Ok(open)
}

/// The viewer's requests to join one group.
struct Asked {
    /// The newest: its id and status.
    latest: (Uuid, String),
    pending: bool,
    declined: bool,
}

/// The viewer's requests to join groups of this room, by group.
async fn join_requests_for(
    pool: &PgPool,
    room_id: Uuid,
    viewer: &str,
) -> sqlx_core::Result<HashMap<String, Asked>> {
    let rows: Vec<(String, Uuid, String)> = query_as(
        "SELECT group_space_id, request_id, status FROM cloud_common_ground_room_join_requests
         WHERE room_id = $1 AND requester_account_id = $2
         ORDER BY created_at DESC, request_id",
    )
    .bind(room_id)
    .bind(viewer)
    .fetch_all(pool)
    .await?;
    let mut out: HashMap<String, Asked> = HashMap::new();
    for (space, request_id, status) in rows {
        let asked = out.entry(space).or_insert_with(|| Asked {
            latest: (request_id, status.clone()),
            pending: false,
            declined: false,
        });
        asked.pending |= status == "pending";
        asked.declined |= status == "declined";
    }
    Ok(out)
}

/// Pending requests to join the groups of this room that `viewer` decides
/// on, by group, oldest first. Requests from people who left the room are
/// left out.
async fn pending_requests(
    pool: &PgPool,
    room_id: Uuid,
    viewer: &str,
) -> sqlx_core::Result<HashMap<String, Vec<Value>>> {
    type PendingRow = (
        String,
        Uuid,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        DateTime<Utc>,
    );
    let rows: Vec<PendingRow> = query_as(&format!(
        "SELECT request.group_space_id, request.request_id, request.requester_account_id,
                account.display_name,
                COALESCE(account.public_handle, account.public_account_number::TEXT),
                account.avatar_url, request.created_at
         FROM cloud_common_ground_room_join_requests request
         JOIN cloud_accounts account ON account.account_id = request.requester_account_id
         JOIN cloud_common_ground_room_groups room_group
           ON room_group.group_space_id = request.group_space_id
         JOIN cloud_chat_conversation_members member
           ON member.conversation_id = room_group.conversation_id AND member.account_id = $2
         JOIN cloud_common_ground_room_members room_member
           ON room_member.room_id = request.room_id
          AND room_member.account_id = request.requester_account_id
          AND room_member.left_at IS NULL
         WHERE request.room_id = $1 AND request.status = 'pending' AND {APPROVER_SQL}
         ORDER BY request.created_at, request.request_id"
    ))
    .bind(room_id)
    .bind(viewer)
    .fetch_all(pool)
    .await?;
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    for (space, request_id, account, name, handle, avatar, created_at) in rows {
        out.entry(space).or_default().push(json!({
            "requestId": request_id,
            "person": person(&account, name.as_deref(), handle.as_deref(), avatar.as_deref()),
            "createdAt": created_at,
        }));
    }
    Ok(out)
}

/// `(groups, invitations)` for `viewer` in this room. Each group carries the
/// viewer's latest request to join it (`joinRequest`), whether they may ask
/// (`canAskToJoin`, always present so clients can detect the feature) and,
/// for its approvers, the pending requests (`requests`).
pub(in crate::common_ground) async fn room_extras(
    pool: &PgPool,
    room_id: Uuid,
    viewer: &str,
) -> sqlx_core::Result<(Value, Value)> {
    let service = crate::system_account::service_account_ids();
    let groups: Vec<GroupRow> = query_as(
        "SELECT room_group.group_space_id, room_group.conversation_id, room_group.name,
                room_group.topic, room_group.created_by, account.display_name, COALESCE(account.public_handle, account.public_account_number::TEXT),
                account.avatar_url,
                (SELECT COUNT(*) FROM cloud_chat_conversation_members member
                 WHERE member.conversation_id = room_group.conversation_id
                   AND member.membership_state = 'active' AND NOT (member.account_id = ANY($3))),
                EXISTS(SELECT 1 FROM cloud_chat_conversation_members member
                       WHERE member.conversation_id = room_group.conversation_id
                         AND member.account_id = $2 AND member.membership_state = 'active')
         FROM cloud_common_ground_room_groups room_group
         JOIN cloud_accounts account ON account.account_id = room_group.created_by
         WHERE room_group.room_id = $1
         ORDER BY room_group.created_at, room_group.group_space_id",
    )
    .bind(room_id)
    .bind(viewer)
    .bind(&service)
    .fetch_all(pool)
    .await?;
    let conversations: Vec<Uuid> = groups.iter().map(|row| row.1).collect();
    let mut members = group_members(pool, &conversations, &service).await?;
    let invitations = invitations(pool, room_id, viewer).await?;
    let invited: HashSet<&str> = invitations
        .iter()
        .filter_map(|invitation| invitation["groupSpaceId"].as_str())
        .collect();
    let asks = join_requests_for(pool, room_id, viewer).await?;
    let open = room_open(pool, room_id).await?;
    let mut pending = pending_requests(pool, room_id, viewer).await?;
    let groups: Vec<Value> = groups
        .into_iter()
        .map(
            |(
                space,
                conversation,
                name,
                topic,
                creator,
                creator_name,
                creator_handle,
                avatar,
                count,
                joined,
            )| {
                let mine = asks.get(&space);
                let latest = mine
                    .map(|asked| json!({ "requestId": asked.latest.0, "status": asked.latest.1 }));
                let blocked_by_request = mine.is_some_and(|asked| asked.pending || asked.declined);
                let can_ask =
                    open && !joined && !invited.contains(space.as_str()) && !blocked_by_request;
                json!({
                    "groupSpaceId": space,
                    "conversationId": conversation,
                    "name": name,
                    "topic": topic,
                    "members": members.remove(&conversation).unwrap_or_default(),
                    "memberCount": count,
                    "createdBy": person(
                        &creator,
                        creator_name.as_deref(),
                        creator_handle.as_deref(),
                        avatar.as_deref(),
                    ),
                    "joined": joined,
                    "joinRequest": latest,
                    "canAskToJoin": can_ask,
                    "requests": pending.remove(&space).unwrap_or_default(),
                })
            },
        )
        .collect();
    Ok((json!(groups), json!(invitations)))
}
