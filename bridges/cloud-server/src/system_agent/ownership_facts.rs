//! What the ownership check reads: recent messages with who wrote and
//! answered them, and person-agent runs and exchanges in the conversation's
//! session.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::plan_cards::store::parse_pg_timestamp;

use super::config::SystemAgentConfig;
use super::input::Candidate;
use super::ownership::{AgentMessage, Delivery, MessageFact, Owner, RunFact, Work};

const MESSAGE_FETCH: i64 = 400;
const RUN_FETCH: i64 = 30;
/// Runs that never own a person's task: the System agent's own, digests,
/// background evaluations, Grounding, and imports.
const BACKGROUND_RUN_PREFIXES: [&str; 7] = [
    super::store::RUN_PREFIX,
    crate::digest::RUN_PREFIX,
    crate::personal_agent::RUN_PREFIX,
    crate::proactive::RUN_PREFIX,
    "cg_",
    "memimport_",
    "import_",
];

/// message_id, sequence, sender, created_at, normalized content, referenced
/// message's sender and normalized content, edited_at
type FactRow = (
    String,
    i64,
    String,
    String,
    Option<Value>,
    Option<String>,
    Option<Value>,
    Option<String>,
);

/// status, owner, owner display name, lease expiry, updated_at, created_at
type RunRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
);

const MESSAGE_FACTS_SQL: &str = "
SELECT m.message_id::text, m.conversation_sequence, m.sender_account_id, m.created_at::text,
       m.attention_content, ref.sender_account_id, ref.attention_content, m.edited_at::text
FROM cloud_chat_messages m
CROSS JOIN LATERAL (
    SELECT COALESCE(
        m.attention_content->>'replyToMessageId',
        CASE WHEN m.attention_content#>>'{messageAction,kind}' IN ('quote', 'thread')
             THEN m.attention_content#>>'{messageAction,source,sourceMessageId}' END,
        m.reply_to_message_id::text) AS raw
) reference
CROSS JOIN LATERAL (
    SELECT CASE WHEN reference.raw ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN substring(reference.raw from '[0-9a-fA-F-]{36}$')::uuid END AS id
) target
LEFT JOIN LATERAL (
    SELECT r.sender_account_id, r.attention_content FROM cloud_chat_messages r
    WHERE r.conversation_id = m.conversation_id AND r.message_id <> m.message_id
      AND (r.message_id = target.id OR r.client_message_id = target.id)
    ORDER BY (r.message_id = target.id) DESC LIMIT 1
) ref ON target.id IS NOT NULL
WHERE m.conversation_id = $1 AND m.conversation_sequence > $2 AND m.deleted_at IS NULL
  AND m.message_kind IN ('text', 'voice')
ORDER BY m.conversation_sequence DESC
LIMIT $3";

fn non_empty(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn possessive(owner_name: Option<String>) -> Option<String> {
    owner_name.map(|name| format!("{name}'s agent"))
}

/// The agent a message was written by, from its normalized content.
fn agent_message(sender: &str, content: &Value) -> Option<AgentMessage> {
    let is_agent = content["senderKind"] == "agent" || content["kind"] == "agent-response";
    if !is_agent {
        return None;
    }
    let delivery = match content["deliveryState"].as_str() {
        Some("processing") => Delivery::Processing,
        Some("failed" | "cancelled") => Delivery::Failed,
        _ => Delivery::Complete,
    };
    let text = content["text"].as_str().unwrap_or_default();
    let exchange_waiting = [
        &content["agentExchangeOutcome"],
        &content["structuredContent"]["agentExchangeOutcome"],
    ]
    .iter()
    .any(|value| value.as_str() == Some("waiting"));
    Some(AgentMessage {
        owner: Owner {
            account_id: non_empty(&content["senderOwnerAccountId"]).or(Some(sender.to_string())),
            agent_name: non_empty(&content["senderDisplayName"])
                .or_else(|| possessive(non_empty(&content["senderOwnerName"]))),
        },
        waiting: delivery == Delivery::Processing
            || exchange_waiting
            || text.contains('?')
            || text.contains('？'),
        delivery,
        changed_at: None,
    })
}

/// The agent a person's message speaks to, when its content names one.
fn mentioned_agent(content: &Value, system_agent: &str) -> Option<Owner> {
    let target = non_empty(&content["targetCloudAgentId"]);
    if target.is_some_and(|target| !target.contains(system_agent)) {
        return Some(Owner {
            account_id: non_empty(&content["targetCloudAgentOwnerAccountId"]),
            agent_name: non_empty(&content["targetCloudAgentName"])
                .or_else(|| possessive(non_empty(&content["targetCloudAgentOwnerName"]))),
        });
    }
    content["mentions"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|mention| {
            mention["targetKind"] == "agent" && !mention.to_string().contains(system_agent)
        })
        .map(|mention| Owner {
            account_id: mention_owner(mention),
            agent_name: non_empty(&mention["label"])
                .map(|label| label.trim_start_matches('@').to_string()),
        })
}

/// The account behind an agent mention: its owner field, or the owner in a
/// default agent id (`cloud-agent:<account>`).
fn mention_owner(mention: &Value) -> Option<String> {
    non_empty(&mention["ownerAccountId"]).or_else(|| {
        ["agentId", "targetIdentityId"].iter().find_map(|key| {
            let id = non_empty(&mention[*key])?;
            let id = id.strip_prefix("agent:").unwrap_or(&id);
            let owner = id.strip_prefix("cloud-agent:")?;
            (!owner.is_empty() && !owner.contains(':')).then(|| owner.to_string())
        })
    })
}

/// Facts for messages after `after`, ascending. `flagged` holds the ids the
/// run input marks as addressed to or answered by an agent.
pub(super) async fn message_facts(
    pool: &PgPool,
    config: &SystemAgentConfig,
    candidate: &Candidate,
    after: i64,
    flagged: &HashSet<String>,
) -> Result<Vec<MessageFact>, sqlx_core::Error> {
    let conversation_id = candidate.conversation_id;
    let rows: Vec<FactRow> = query_as(MESSAGE_FACTS_SQL)
        .bind(conversation_id)
        .bind(after)
        .bind(MESSAGE_FETCH)
        .fetch_all(pool)
        .await?;
    let answers = exchange_answers(pool, candidate).await?;
    let not_people = [
        config.account_id.as_str(),
        crate::system_account::SYSTEM_ACCOUNT_ID,
    ];
    let mut facts: Vec<MessageFact> = rows
        .into_iter()
        .filter_map(
            |(id, sequence, sender, created_at, content, ref_sender, ref_content, edited)| {
                let created_at = parse_pg_timestamp(&created_at)?.with_timezone(&Utc);
                let content = content.unwrap_or(Value::Null);
                let person = !not_people.contains(&sender.as_str());
                let mut agent = person.then(|| agent_message(&sender, &content)).flatten();
                if let Some(agent) = &mut agent {
                    agent.changed_at = edited
                        .as_deref()
                        .and_then(parse_pg_timestamp)
                        .map(|at| at.with_timezone(&Utc));
                }
                let replied_to_agent = ref_sender
                    .zip(ref_content)
                    .and_then(|(sender, content)| agent_message(&sender, &content))
                    .map(|agent| agent.owner);
                // A person's answer to an agent's question belongs to that
                // agent's task, however it was written.
                let addressed_owner = answers
                    .get(&id)
                    .cloned()
                    .or(replied_to_agent)
                    .or_else(|| mentioned_agent(&content, &config.account_id))
                    .or_else(|| flagged.contains(&id).then(Owner::default));
                Some(MessageFact {
                    sequence,
                    created_at,
                    human: person && agent.is_none(),
                    agent,
                    addressed_owner,
                })
            },
        )
        .collect();
    facts.reverse();
    Ok(facts)
}

/// Messages recorded as the answer to an agent's collaboration request in
/// the session, with the agent that asked. A person's answer to a question
/// an agent asked them is that agent's task, never new plan talk.
async fn exchange_answers(
    pool: &PgPool,
    candidate: &Candidate,
) -> Result<HashMap<String, Owner>, sqlx_core::Error> {
    let rows: Vec<(String, String, Option<String>)> = query_as(
        "SELECT exchange.response_message_id::text, run.owner_account_id, account.display_name
         FROM cloud_agent_exchanges exchange
         JOIN cloud_agent_fallback_runs run ON run.run_id = exchange.parent_run_id
         LEFT JOIN cloud_accounts account ON account.account_id = run.owner_account_id
         WHERE exchange.response_message_id IS NOT NULL
           AND exchange.created_at > now() - interval '1 day'
           AND run.session_id = $1
           AND run.requester_account_id IN (
               SELECT member.account_id FROM cloud_chat_conversation_members member
               WHERE member.conversation_id = $2)",
    )
    .bind(&candidate.legacy_session_id)
    .bind(candidate.conversation_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(message_id, owner, owner_name)| {
            let owner = Owner {
                account_id: Some(owner),
                agent_name: possessive(owner_name),
            };
            (message_id, owner)
        })
        .collect())
}

/// Person-agent runs in the session, newest first, and an exchange still
/// waiting on a reply. Requesters are the conversation's members, which keeps
/// the lookup on the runs' requester and session index.
pub(super) async fn open_work(
    pool: &PgPool,
    candidate: &Candidate,
) -> Result<Work, sqlx_core::Error> {
    let rows: Vec<RunRow> = query_as(
        "SELECT run.status, run.owner_account_id, account.display_name, run.lease_expires_at,
                run.updated_at, run.created_at
         FROM cloud_agent_fallback_runs run
         LEFT JOIN cloud_accounts account ON account.account_id = run.owner_account_id
         WHERE run.session_id = $1 AND NOT EXISTS (SELECT 1 FROM unnest($3::text[]) prefix
                           WHERE starts_with(run.run_id, prefix))
           AND run.requester_account_id IN (
               SELECT member.account_id FROM cloud_chat_conversation_members member
               WHERE member.conversation_id = $2)
         ORDER BY run.created_at DESC
         LIMIT $4",
    )
    .bind(&candidate.legacy_session_id)
    .bind(candidate.conversation_id)
    .bind(BACKGROUND_RUN_PREFIXES.as_slice())
    .bind(RUN_FETCH)
    .fetch_all(pool)
    .await?;
    let instant = |value: Option<&str>| {
        value
            .and_then(parse_pg_timestamp)
            .map(|at| at.with_timezone(&Utc))
    };
    let runs = rows
        .into_iter()
        .map(
            |(status, owner, owner_name, lease, updated, created)| RunFact {
                status,
                owner: Owner {
                    account_id: Some(owner),
                    agent_name: possessive(owner_name),
                },
                lease_expires_at: instant(lease.as_deref()),
                updated_at: instant(Some(&updated)),
                created_at: instant(Some(&created)),
            },
        )
        .collect();
    let exchange: Option<(String, Option<String>)> = query_as(
        "SELECT run.owner_account_id, account.display_name
         FROM cloud_agent_exchanges exchange
         JOIN cloud_agent_fallback_runs run ON run.run_id = exchange.parent_run_id
         LEFT JOIN cloud_accounts account ON account.account_id = run.owner_account_id
         WHERE exchange.status IN ('pending', 'reply_received', 'resuming')
           AND exchange.created_at > now() - interval '1 hour'
           AND run.session_id = $1
           AND run.requester_account_id IN (
               SELECT member.account_id FROM cloud_chat_conversation_members member
               WHERE member.conversation_id = $2)
         LIMIT 1",
    )
    .bind(&candidate.legacy_session_id)
    .bind(candidate.conversation_id)
    .fetch_optional(pool)
    .await?;
    Ok(Work {
        runs,
        pending_exchange: exchange.map(|(owner, owner_name)| Owner {
            account_id: Some(owner),
            agent_name: possessive(owner_name),
        }),
    })
}
