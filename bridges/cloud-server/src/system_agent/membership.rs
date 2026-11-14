//! The System agent (the Facilitator) is a standing member of every group
//! conversation, Grounding groups included, so members can always @ it.
//! Membership is not a setting: it is added at creation and backfilled at
//! startup. In Grounding groups it only answers direct requests; their
//! notices come from the notice account (`crate::system_account`).

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

/// Conversation kinds the System agent joins automatically. Direct and AI
/// sessions are deliberately excluded until both clients render a third member
/// there.
pub const SYSTEM_AGENT_CONVERSATION_KINDS: &[&str] = &["group"];

/// Adds the System agent to one conversation. Returns whether a new membership
/// was created. Members' devices hear about it through `membership.updated`,
/// and the System agent starts reading at the conversation's newest message, so
/// history from before it joined is never treated as new.
pub async fn join_conversation(
    pool: &PgPool,
    system_agent_account_id: &str,
    conversation_id: Uuid,
) -> Result<bool, sqlx_core::Error> {
    let inserted = crate::chat_sync::store::join_service_member(
        pool,
        conversation_id,
        system_agent_account_id,
        SYSTEM_AGENT_CONVERSATION_KINDS,
    )
    .await
    .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    if inserted {
        query(
            "INSERT INTO cloud_pip_conversation_state
                 (conversation_id, seen_sequence, context_start_sequence)
             SELECT conversation_id, latest_message_sequence, latest_message_sequence
             FROM cloud_chat_conversations
             WHERE conversation_id = $1
             ON CONFLICT (conversation_id) DO UPDATE SET
                 seen_sequence = GREATEST(cloud_pip_conversation_state.seen_sequence,
                                          EXCLUDED.seen_sequence),
                 updated_at = now()",
        )
        .bind(conversation_id)
        .execute(pool)
        .await?;
    }
    Ok(inserted)
}

/// Backfills the System agent into every existing conversation of a supported
/// kind, including Grounding groups it left before it could be mentioned there.
pub async fn join_all_groups(
    pool: &PgPool,
    system_agent_account_id: &str,
) -> Result<u64, sqlx_core::Error> {
    let missing: Vec<(Uuid,)> = query_as(
        "SELECT conversation.conversation_id
         FROM cloud_chat_conversations conversation
         WHERE conversation.kind = ANY($2)
           AND NOT EXISTS (
               SELECT 1 FROM cloud_chat_conversation_members member
               WHERE member.conversation_id = conversation.conversation_id
                 AND member.account_id = $1
                 AND member.membership_state = 'active')",
    )
    .bind(system_agent_account_id)
    .bind(SYSTEM_AGENT_CONVERSATION_KINDS)
    .fetch_all(pool)
    .await?;
    let mut joined = 0;
    for (conversation_id,) in missing {
        if join_conversation(pool, system_agent_account_id, conversation_id).await? {
            joined += 1;
        }
    }
    Ok(joined)
}

/// Whether `conversation_id` is a Grounding group, where the System agent
/// only answers people who ask it directly.
pub(super) async fn is_room_group(
    pool: &PgPool,
    conversation_id: Uuid,
) -> Result<bool, sqlx_core::Error> {
    let (room_group,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_common_ground_room_groups WHERE conversation_id = $1)",
    )
    .bind(conversation_id)
    .fetch_one(pool)
    .await?;
    Ok(room_group)
}
