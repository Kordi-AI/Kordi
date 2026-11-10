//! Member snapshots: each member's identity, membership and cursors, and the
//! read watermark of their own messages (`read_outbox_sequence`).

use super::*;

pub(super) type MemberRow = (
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    String,
    String,
    i32,
    i64,
    i64,
    i64,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
);

pub(super) fn member_from_row(row: MemberRow) -> MemberSnapshot {
    MemberSnapshot {
        default_agent_id: format!("cloud-agent:{}", row.0),
        account_id: row.0,
        display_name: row.1,
        avatar_url: row.2,
        default_agent_display_name: row.3,
        default_agent_avatar_url: row.4,
        role: row.5,
        membership_state: row.6,
        version: row.7,
        last_delivered_sequence: row.8,
        last_read_sequence: row.9,
        read_outbox_sequence: row.10,
        joined_at: row.11,
        left_at: row.12,
    }
}

pub(super) async fn member_rows(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
) -> Result<Vec<MemberSnapshot>, StoreError> {
    let rows: Vec<MemberRow> = query_as(
        "SELECT member.account_id, account.display_name, account.avatar_url, \
                agent.display_name, agent.avatar_url, \
                member.role, member.membership_state, member.version, \
                member.last_delivered_sequence, member.last_read_sequence, \
                COALESCE(outbox.sequence, 0), member.joined_at, member.left_at \
         FROM cloud_chat_conversation_members member \
         JOIN cloud_accounts account ON account.account_id = member.account_id \
         JOIN cloud_default_agent_profiles agent ON agent.owner_account_id = member.account_id \
         LEFT JOIN cloud_chat_read_outbox outbox \
           ON outbox.conversation_id = member.conversation_id \
          AND outbox.account_id = member.account_id \
         WHERE member.conversation_id = $1 \
         ORDER BY member.joined_at ASC, member.account_id ASC",
    )
    .bind(conversation_id)
    .fetch_all(&mut **transaction)
    .await?;
    Ok(rows.into_iter().map(member_from_row).collect())
}
