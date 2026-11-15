//! Inviting Grounding people into groups: an active owner or admin of a
//! group invites someone they share Grounding with (both still in the same
//! room, a pairing, or an opened match), never across a block and only when
//! the person lets them see their card. Contacts are added directly; anyone
//! else gets an invitation they join or decline from Contacts › Requests.
//!
//! An invitation is live only while its inviter is still an active owner or
//! admin of the group and the invitee is not already in it. Lists filter
//! lazily; joining marks a stale invitation withdrawn. Declining is quiet.

mod answer;
mod lists;
mod send;

pub(in crate::common_ground) use answer::{decline_group_invitation, join_group_invitation};
pub(super) use lists::pending_group_invitations;
pub(in crate::common_ground) use lists::{group_people, person_groups};
pub(in crate::common_ground) use send::invite_to_group;

use std::collections::HashMap;

use axum::{http::StatusCode, response::Response};
use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::join_requests::APPROVER_SQL;
use crate::common_ground::err;
use crate::common_ground::people::{person, visible_sql};
use crate::contact_permissions::card_allowed_sql;

/// The account hint that tells the invitee's devices to refresh
/// `GET /v1/cloud/common-ground/invitations`.
const HINT: &str = "common_ground.invitations.updated";

/// The group's display name, for a conversation aliased `c` with its room
/// group (if any) left-joined as `room_group`.
const NAME_SQL: &str =
    "COALESCE(NULLIF(btrim(c.group_title), ''), NULLIF(btrim(c.shared_title), ''),
                                 room_group.name, 'Group')";

/// True for the first channel of a group space, for a conversation aliased
/// `c`: later channels share the group's roster and are not separate groups.
const FIRST_CHANNEL_SQL: &str = "NOT EXISTS (
    SELECT 1 FROM cloud_chat_conversations first_channel
    WHERE c.group_space_id IS NOT NULL AND first_channel.kind = 'group'
      AND first_channel.group_space_id = c.group_space_id
      AND (first_channel.created_at, first_channel.conversation_id) < (c.created_at, c.conversation_id))";

/// True while an invitation aliased `invite` is live: its inviter is still
/// an active owner or admin of the group and the invitee is not in it.
const LIVE_SQL: &str = "EXISTS (
        SELECT 1 FROM cloud_chat_conversation_members member
        WHERE member.conversation_id = invite.conversation_id
          AND member.account_id = invite.inviter_account_id
          AND member.membership_state = 'active' AND member.role IN ('owner', 'admin'))
    AND NOT EXISTS (
        SELECT 1 FROM cloud_chat_conversation_members joined
        WHERE joined.conversation_id = invite.conversation_id
          AND joined.account_id = invite.invitee_account_id
          AND joined.membership_state = 'active')";

/// SQL that is true when the account in `inviter` may invite the account in
/// `other` (both SQL expressions): no block either way, `other` lets
/// `inviter` see their card, and they share a room or a pairing
/// ([`visible_sql`]) or `inviter` opened a match with `other`.
fn invitable_sql(inviter: &str, other: &str) -> String {
    format!(
        "(NOT cloud_accounts_blocked_either_way({inviter}, {other}) AND {allowed} AND ({visible}
          OR EXISTS (SELECT 1 FROM cloud_common_ground_matches opened_match
                     WHERE opened_match.viewer_account_id = {inviter}
                       AND opened_match.other_account_id = {other}
                       AND opened_match.opened_at IS NOT NULL)))",
        allowed = card_allowed_sql(other, inviter),
        visible = visible_sql(inviter, other),
    )
}

/// SQL selecting the most recent room both `viewer` and `other` are still
/// in and share their linked profiles in: its id, name and when the later
/// of the two joined it.
fn shared_room_sql(viewer: &str, other: &str) -> String {
    use crate::common_ground::people::shares_sql;
    format!(
        "SELECT room.room_id, room.name, GREATEST(mine.joined_at, theirs.joined_at)
         FROM cloud_common_ground_room_members mine
         JOIN cloud_common_ground_room_members theirs
           ON theirs.room_id = mine.room_id AND theirs.account_id = {other}
              AND theirs.left_at IS NULL
         JOIN cloud_common_ground_rooms room ON room.room_id = mine.room_id
         WHERE mine.account_id = {viewer} AND mine.left_at IS NULL
           AND {mine_shares} AND {theirs_shares}
         ORDER BY GREATEST(mine.joined_at, theirs.joined_at) DESC, room.room_id
         LIMIT 1",
        mine_shares = shares_sql("mine.profile_id"),
        theirs_shares = shares_sql("theirs.profile_id"),
    )
}

/// A group the viewer may invite people to.
struct Group {
    conversation_id: Uuid,
    space: String,
}

/// The group with this space id when `viewer` is an active owner or admin.
async fn admin_group(pool: &PgPool, space: &str, viewer: &str) -> sqlx_core::Result<Option<Group>> {
    let space = space.trim();
    if space.is_empty() {
        return Ok(None);
    }
    let row: Option<(Uuid, String)> = query_as(&format!(
        "SELECT c.conversation_id, c.legacy_session_id
         FROM cloud_chat_conversations c
         JOIN cloud_chat_conversation_members member
           ON member.conversation_id = c.conversation_id AND member.account_id = $2
         WHERE c.legacy_session_id = $1 AND c.kind = 'group' AND {APPROVER_SQL}"
    ))
    .bind(space)
    .bind(viewer)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(conversation_id, space)| Group {
        conversation_id,
        space,
    }))
}

fn forbidden() -> Response {
    err(
        "common_ground_group_forbidden",
        "Only group admins can invite.",
        StatusCode::FORBIDDEN,
    )
}

fn invitation_not_found() -> Response {
    err(
        "common_ground_invitation_not_found",
        "Invitation not found.",
        StatusCode::NOT_FOUND,
    )
}

/// Up to `limit` active people in each conversation, owner first, then by
/// join order, and how many active people each has. Service accounts are
/// left out of both.
async fn group_people_preview(
    pool: &PgPool,
    conversations: &[Uuid],
    limit: usize,
) -> sqlx_core::Result<(HashMap<Uuid, Vec<Value>>, HashMap<Uuid, i64>)> {
    type MemberRow = (Uuid, String, Option<String>, Option<String>, Option<String>);
    let rows: Vec<MemberRow> = query_as(
        "SELECT member.conversation_id, member.account_id, account.display_name,
                COALESCE(account.public_handle, account.public_account_number::TEXT), account.avatar_url
         FROM cloud_chat_conversation_members member
         JOIN cloud_accounts account ON account.account_id = member.account_id
         WHERE member.conversation_id = ANY($1) AND member.membership_state = 'active'
           AND NOT (member.account_id = ANY($2))
         ORDER BY member.conversation_id, member.role = 'owner' DESC, member.joined_at,
                  member.account_id",
    )
    .bind(conversations)
    .bind(crate::system_account::service_account_ids())
    .fetch_all(pool)
    .await?;
    let mut members: HashMap<Uuid, Vec<Value>> = HashMap::new();
    let mut counts: HashMap<Uuid, i64> = HashMap::new();
    for (conversation, account, name, handle, avatar) in rows {
        *counts.entry(conversation).or_default() += 1;
        let shown = members.entry(conversation).or_default();
        if shown.len() < limit {
            shown.push(person(
                &account,
                name.as_deref(),
                handle.as_deref(),
                avatar.as_deref(),
            ));
        }
    }
    Ok((members, counts))
}
