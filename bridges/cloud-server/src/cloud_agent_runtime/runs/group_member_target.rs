//! The group co-member rule for targeting another person's agents
//! (docs/contact-permissions.md#agent-access).

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::{ClaimRunRequest, RunResult};

/// In a group chat, an active member may target another active member's
/// agents without a contact record: people in the owner's group chats can
/// mention the default agent (docs/contact-permissions.md). The owner's
/// "Use my agent" switch and the agent's Access still decide, a block in
/// either direction refuses, and the System agent and System are never
/// targets. `None` outside group chats, where the contact rule of
/// `requester_can_target_owner` stays the only rule. The Cloud and Mac claim
/// paths both apply it.
pub async fn group_member_can_target_owner(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> RunResult<Option<bool>> {
    let (requester, owner) = (
        input.requester_account_id.trim(),
        input.owner_account_id.trim(),
    );
    let (is_group,): (bool,) = query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_chat_conversations
                        WHERE (legacy_session_id = $1 OR conversation_id = $2)
                          AND kind = 'group')",
    )
    .bind(input.session_id.trim())
    .bind(uuid::Uuid::parse_str(input.session_id.trim()).ok())
    .fetch_one(pool)
    .await?;
    if !is_group {
        return Ok(None);
    }
    if requester == owner {
        return Ok(Some(true));
    }
    if crate::system_account::is_service_account(owner)
        || crate::safety::blocks::blocked_either_way(pool, requester, owner).await?
    {
        return Ok(Some(false));
    }
    let members = crate::auth::routes::cloud_session_participants(pool, &input.session_id).await?;
    if !members.iter().any(|id| id == owner) || !members.iter().any(|id| id == requester) {
        return Ok(Some(false));
    }
    Ok(Some(
        super::authorization::requester_may_use_owner_agents(pool, input).await?,
    ))
}
