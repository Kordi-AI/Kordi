//! Claim authorization and shared-agent target resolution.

use futures_util::TryStreamExt;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::envelopes::{cloud_group_request_envelope_for_run, direct_cloud_agent_target};
use super::group_mentions::agent_handoff_target;
use super::group_target::human_group_target;
use super::{ClaimRunRequest, RunResult};

/// Resolve transport aliases without changing the durable group request identity.
pub async fn request_identity(
    pool: &PgPool,
    session_id: &str,
    request_id: &str,
) -> RunResult<Option<(String, String)>> {
    let mut rows=query_as::<_,(String,String,String)>("SELECT m.message_id::text,m.client_message_id::text,m.content #>> '{blocks,0,text}' FROM cloud_chat_messages m JOIN cloud_chat_conversations c USING(conversation_id) WHERE c.legacy_session_id=$1 AND m.deleted_at IS NULL AND m.content #>> '{blocks,0,text}' IS NOT NULL ORDER BY m.conversation_sequence DESC")
        .bind(session_id).fetch(pool);
    while let Some((wire, client, body)) = rows.try_next().await? {
        let logical = super::envelopes::parse_cloud_group_envelope(&body)
            .and_then(|envelope| envelope.message.map(|message| message.id));
        if request_id == wire
            || request_id == client
            || request_id == format!("ios_{client}")
            || logical.as_deref() == Some(request_id)
        {
            return Ok(Some((logical.unwrap_or_else(|| wire.clone()), wire)));
        }
    }
    Ok(None)
}

pub async fn requester_can_target_owner(
    pool: &PgPool,
    requester_account_id: &str,
    owner_account_id: &str,
) -> RunResult<bool> {
    if requester_account_id == owner_account_id {
        return Ok(true);
    }
    if is_service_owner(owner_account_id)
        || !crate::contact_permissions::agent_allowed(pool, owner_account_id, requester_account_id)
            .await?
    {
        return Ok(false);
    }
    if crate::safety::blocks::blocked_either_way(pool, requester_account_id, owner_account_id)
        .await?
    {
        return Ok(false);
    }
    let row: Option<(String,)> = query_as(
        "SELECT peer_account_id FROM cloud_contacts WHERE account_id = $1 AND peer_account_id = $2 LIMIT 1",
    )
    .bind(requester_account_id)
    .bind(owner_account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// False when the owner stopped the requester from using their agents, or
/// the agent this claim runs is not open to the requester under its Access
/// (docs/contact-permissions.md). The owner is always allowed.
pub async fn requester_may_use_owner_agents(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> RunResult<bool> {
    if input.owner_account_id.trim() == input.requester_account_id.trim() {
        return Ok(true);
    }
    let agent_id = execution_agent_id(pool, input).await?;
    Ok(crate::agent_access::agent_usable(
        pool,
        &input.owner_account_id,
        &input.requester_account_id,
        &agent_id,
    )
    .await?)
}

pub async fn validate_group_agent_claim(pool: &PgPool, input: &ClaimRunRequest) -> RunResult<bool> {
    // The assignee's approval owns the run for a Facilitator handoff.
    if input
        .request_message_id
        .starts_with(super::facilitator_handoff::REQUEST_PREFIX)
    {
        return Ok(false);
    }
    // Neither side of a block can use the other's agents, in any chat.
    let (requester, owner) = (
        input.requester_account_id.trim(),
        input.owner_account_id.trim(),
    );
    if requester != owner
        && crate::safety::blocks::blocked_either_way(pool, requester, owner).await?
    {
        return Ok(false);
    }
    if !requester_may_use_owner_agents(pool, input).await? {
        return Ok(false);
    }
    if let Some(allowed) = super::exchanges::validate_claim(pool, input).await? {
        return Ok(allowed);
    }
    let Some(envelope) =
        cloud_group_request_envelope_for_run(pool, &input.session_id, &input.request_message_id)
            .await?
    else {
        return Ok(!input.session_id.trim().starts_with("session:group:"));
    };
    let Some(message) = envelope.message.as_ref() else {
        return Ok(false);
    };
    if message.fork_snapshot == Some(true)
        || message.message_action.as_ref().is_some_and(|action| {
            action.get("kind").and_then(serde_json::Value::as_str) == Some("forward")
        })
    {
        return Ok(false);
    }
    if message.sender_account_id.trim() != input.requester_account_id.trim() {
        return Ok(false);
    }
    let members = crate::auth::routes::cloud_session_participants(pool, &input.session_id).await?;
    if !members.iter().any(|id| id == input.owner_account_id.trim())
        || !members
            .iter()
            .any(|id| id == input.requester_account_id.trim())
    {
        return Ok(false);
    }
    // Only a person's message starts an agent's run. An agent reaches another
    // agent through reach_out, never by mentioning it in its reply text. The
    // one exception is the System agent pushing a stalled chat forward: its
    // structured mention starts that agent's run with itself as requester,
    // which leaves the run a non-owner's restricted authority.
    if message.sender_kind.as_deref() == Some("agent") {
        return Ok(system_agent_target(message, &envelope.participants)
            .is_some_and(|target| target.owner_account_id == input.owner_account_id.trim()));
    }
    Ok(human_group_target(message, &envelope.participants)
        .is_some_and(|target| target.owner_account_id == input.owner_account_id.trim()))
}

#[derive(Debug, Clone)]
pub(super) struct SharedCloudAgentTarget {
    pub(super) agent_id: String,
    pub(super) owner_account_id: String,
    pub(super) owner_name: Option<String>,
}

pub(super) async fn shared_cloud_agent_target_for_claim(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> Result<Option<SharedCloudAgentTarget>, sqlx_core::Error> {
    if let Some(envelope) =
        cloud_group_request_envelope_for_run(pool, &input.session_id, &input.request_message_id)
            .await?
    {
        if let Some(message) = envelope.message.as_ref() {
            if message.sender_kind.as_deref() != Some("agent") {
                return Ok(
                    human_group_target(message, &envelope.participants).and_then(|target| {
                        if target.agent_id == format!("cloud-agent:{}", input.owner_account_id)
                            && target.owner_account_id == input.owner_account_id
                        {
                            return None;
                        }
                        Some(SharedCloudAgentTarget {
                            owner_name: envelope
                                .participants
                                .iter()
                                .find(|p| p.account_id == target.owner_account_id)
                                .map(|p| p.display_name.clone()),
                            agent_id: target.agent_id,
                            owner_account_id: target.owner_account_id,
                        })
                    }),
                );
            }
            if let Some(target) = agent_handoff_target(&envelope) {
                if target.agent_id == format!("cloud-agent:{}", input.owner_account_id)
                    && target.participant.account_id == input.owner_account_id
                {
                    return Ok(None);
                }
                return Ok(Some(SharedCloudAgentTarget {
                    agent_id: target.agent_id,
                    owner_account_id: target.participant.account_id,
                    owner_name: Some(target.participant.display_name),
                }));
            }
        }
    }

    let row: Option<(String,)> = query_as(
        "SELECT message.content #>> '{blocks,0,text}'
         FROM cloud_chat_messages message
         JOIN cloud_chat_conversations conversation
           ON conversation.conversation_id = message.conversation_id
         WHERE message.message_id::text = $1
           AND conversation.legacy_session_id = $2
           AND message.deleted_at IS NULL",
    )
    .bind(&input.request_message_id)
    .bind(&input.session_id)
    .fetch_optional(pool)
    .await?;
    let Some(target) = row.and_then(|(body,)| direct_cloud_agent_target(&body)) else {
        return personal_session_target(pool, input).await;
    };
    if is_default_kordi_target(
        &target.agent_id,
        &target.owner_account_id,
        &input.requester_account_id,
    ) && target.owner_account_id == input.owner_account_id
    {
        return Ok(None);
    }
    Ok(Some(SharedCloudAgentTarget {
        agent_id: target.agent_id,
        owner_account_id: target.owner_account_id,
        owner_name: target.owner_name,
    }))
}

/// A request with no target in the personal session of an owned definition
/// goes to that agent (docs/development/personal-agent.md).
async fn personal_session_target(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> Result<Option<SharedCloudAgentTarget>, sqlx_core::Error> {
    let Some(agent_id) = crate::personal_agent::sessions::default_target(
        pool,
        &input.session_id,
        &input.owner_account_id,
        &input.requester_account_id,
    )
    .await?
    else {
        return Ok(None);
    };
    let owner: Option<(Option<String>,)> =
        query_as("SELECT display_name FROM cloud_accounts WHERE account_id = $1")
            .bind(&input.owner_account_id)
            .fetch_optional(pool)
            .await?;
    Ok(Some(SharedCloudAgentTarget {
        agent_id,
        owner_account_id: input.owner_account_id.clone(),
        owner_name: owner.and_then(|(name,)| name),
    }))
}

/// The System agent lives in every group and runs on a Kordi-operated key, so
/// members may never start an agent run on its account; its own sweep queues
/// its runs.
/// System posts notices only and never runs an agent for anyone.
fn is_service_owner(owner_account_id: &str) -> bool {
    crate::system_account::is_service_account(owner_account_id)
}

fn is_default_kordi_target(
    agent_id: &str,
    owner_account_id: &str,
    requester_account_id: &str,
) -> bool {
    agent_id == format!("cloud-agent:{owner_account_id}")
        || agent_id == format!("cloud-self:{owner_account_id}")
        || (is_local_default_agent_alias(agent_id) && owner_account_id == requester_account_id)
}

/// Desktop-local aliases for the owner's default Kordi. `local:<hash>` is the
/// canonical id of the desktop's local delegate (one per profile/workspace) and
/// names where the agent runs, not a separate Cloud agent definition.
pub(super) fn is_local_default_agent_alias(agent_id: &str) -> bool {
    agent_id == "cloud-local-agent"
        || agent_id
            .strip_prefix("local:")
            .is_some_and(|hash| !hash.is_empty())
}

pub async fn execution_agent_id(pool: &PgPool, input: &ClaimRunRequest) -> RunResult<String> {
    if let Some(agent) = super::exchanges::agent_for_claim(pool, input).await? {
        return Ok(agent);
    }
    Ok(shared_cloud_agent_target_for_claim(pool, input)
        .await?
        .map(|target| target.agent_id)
        .unwrap_or_else(|| format!("cloud-agent:{}", input.owner_account_id)))
}

pub async fn claim_has_shared_cloud_agent_target(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> RunResult<bool> {
    Ok(shared_cloud_agent_target_for_claim(pool, input)
        .await?
        .is_some())
}

pub async fn validate_shared_cloud_agent_claim(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> RunResult<bool> {
    if !requester_may_use_owner_agents(pool, input).await? {
        return Ok(false);
    }
    if let Some(allowed) = super::exchanges::validate_claim(pool, input).await? {
        return Ok(allowed);
    }
    let Some(target) = shared_cloud_agent_target_for_claim(pool, input).await? else {
        return Ok(true);
    };
    if target.owner_account_id != input.owner_account_id
        || (is_service_owner(&target.owner_account_id)
            && input.requester_account_id != target.owner_account_id)
    {
        return Ok(false);
    }
    let participants =
        crate::auth::routes::cloud_session_participants(pool, &input.session_id).await?;
    if !participants
        .iter()
        .any(|id| id == &input.requester_account_id)
        || !participants.iter().any(|id| id == &input.owner_account_id)
    {
        return Ok(false);
    }
    let row: Option<(String, String)> = query_as(
        "SELECT access_scope, status FROM cloud_agent_definitions WHERE agent_id = $1 AND owner_account_id = $2",
    )
    .bind(&target.agent_id)
    .bind(&target.owner_account_id)
    .fetch_optional(pool)
    .await?;
    Ok(
        matches!(row, Some((access_scope, status)) if status == "active"
        && (target.owner_account_id == input.requester_account_id
            || access_scope == "participant_conversations")),
    )
}

#[cfg(test)]
mod tests {
    use super::is_default_kordi_target;

    #[test]
    fn default_kordi_targets_are_not_shared_agent_definitions() {
        assert!(is_default_kordi_target(
            "cloud-agent:acct_owner",
            "acct_owner",
            "acct_requester"
        ));
        assert!(is_default_kordi_target(
            "cloud-local-agent",
            "acct_owner",
            "acct_owner"
        ));
        assert!(!is_default_kordi_target(
            "cloud-local-agent",
            "acct_owner",
            "acct_requester"
        ));
    }

    #[test]
    fn local_delegate_targets_are_the_owner_default_agent() {
        // A private Agent Chat forwarded from the desktop can name the local
        // delegate (`local:<hash>`); the claim must run as `cloud-agent:<owner>`.
        assert!(is_default_kordi_target(
            "local:060c69e6f296f6acea5df9d653cc305c",
            "acct_owner",
            "acct_owner"
        ));
        assert!(!is_default_kordi_target(
            "local:060c69e6f296f6acea5df9d653cc305c",
            "acct_owner",
            "acct_requester"
        ));
        assert!(!is_default_kordi_target(
            "local:",
            "acct_owner",
            "acct_owner"
        ));
    }
}

/// The agent a System agent message names by structured mention or target,
/// resolved as a person's request would be; never by text alone.
pub(super) fn system_agent_target(
    message: &super::envelopes::CloudGroupMessage,
    participants: &[super::envelopes::CloudGroupParticipant],
) -> Option<super::group_target::GroupAgentTarget> {
    let sender = message.sender_account_id.trim();
    if crate::system_agent::service_account_id() != Some(sender) {
        return None;
    }
    let structured = message.target_cloud_agent_id.is_some()
        || message
            .mentions
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|m| m["targetKind"] == "agent");
    if !structured {
        return None;
    }
    let mut as_request = message.clone();
    as_request.sender_kind = Some("human".into());
    let mut participants = participants.to_vec();
    if !participants.iter().any(|p| p.account_id == sender) {
        participants.push(super::envelopes::CloudGroupParticipant {
            account_id: sender.into(),
            display_name: crate::system_agent::DEFAULT_SYSTEM_AGENT_NAME.into(),
            avatar_url: None,
            agent_id: None,
            agent_display_name: None,
            agent_avatar_url: None,
            role: Some("system".into()),
        });
    }
    human_group_target(&as_request, &participants)
}

#[cfg(test)]
mod system_agent_mention_tests {
    use super::super::envelopes::CloudGroupEnvelope;

    fn envelope(sender: &str, structured: bool) -> CloudGroupEnvelope {
        let mut message = serde_json::json!({"id":"m","senderAccountId":sender,"senderKind":"agent","text":"@KordiOwner please continue","createdAtMs":1});
        if structured {
            message["mentions"] = serde_json::json!([{"targetKind":"agent","agentId":"cloud-agent:owner","humanId":"owner","label":"KordiOwner","displayText":"@KordiOwner","startUtf16":0,"lengthUtf16":11}]);
        }
        serde_json::from_value(serde_json::json!({"kind":"group-message","groupId":"g","createdByAccountId":"owner","actor":{"accountId":"owner","displayName":"Owner"},
            "participants":[{"accountId":"owner","displayName":"Owner"},{"accountId":"person","displayName":"Person"}],"message":message})).unwrap()
    }

    #[test]
    fn only_the_system_agents_structured_mention_names_an_agent() {
        let system = crate::system_agent::test_service_account();
        let pushed = envelope(system, true);
        let target =
            super::system_agent_target(pushed.message.as_ref().unwrap(), &pushed.participants)
                .unwrap();
        assert_eq!(target.owner_account_id, "owner");
        assert_eq!(target.agent_id, "cloud-agent:owner");
        let text_only = envelope(system, false);
        assert!(super::system_agent_target(
            text_only.message.as_ref().unwrap(),
            &text_only.participants
        )
        .is_none());
        let person_agent = envelope("person", true);
        assert!(super::system_agent_target(
            person_agent.message.as_ref().unwrap(),
            &person_agent.participants
        )
        .is_none());
    }
}
