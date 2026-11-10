//! Loads what the ownership check needs (recent messages, person-agent runs
//! and exchanges in the conversation's session), applies its outcome to the
//! run input, and keeps the deferred task in the sweep row.

use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::plan_cards::store::parse_pg_timestamp;

use super::config::SystemAgentConfig;
use super::input::{build_input, Candidate};
use super::ownership::{
    assess, mark, state_patch, step_in, AgentMessage, Clock, Deferral, Delivery, MessageFact,
    Outcome, Owner, RunFact, SteppedIn, Work, DEFERRED_KEY,
};
use super::triggers::PlanDiscussion;

/// What the trigger check needs from the ownership pass.
#[derive(Clone, Debug, Default)]
pub(super) struct Gate {
    /// The run picks up a stalled agent's task.
    pub stepping_in: bool,
    /// An agent owns a task here: waiting, or it replied or stalled this pass.
    pub agent_task: bool,
    /// The owning agent may still reply, or a person's agent is working now.
    pub agent_busy: bool,
    /// The newest and the first new message a person wrote themselves.
    pub last_human_at: Option<DateTime<Utc>>,
    pub first_new_human_at: Option<DateTime<Utc>>,
    /// The newest message a person's agent wrote.
    pub newest_agent_sequence: Option<i64>,
    /// Messages written by a person's agent, with that agent's name.
    pub agents: BTreeMap<i64, Option<String>>,
}

fn gate(
    outcome: &Outcome,
    seen: i64,
    messages: &[MessageFact],
    working: bool,
    agents: &BTreeMap<i64, Option<String>>,
) -> Gate {
    let humans = messages.iter().filter(|message| message.human);
    Gate {
        stepping_in: matches!(outcome, Outcome::Stalled(_)),
        agent_task: !matches!(outcome, Outcome::Free),
        agent_busy: working || matches!(outcome, Outcome::Waiting(_)),
        last_human_at: humans.clone().map(|message| message.created_at).max(),
        first_new_human_at: humans
            .filter(|message| message.sequence > seen)
            .map(|message| message.created_at)
            .min(),
        newest_agent_sequence: agents.keys().next_back().copied(),
        agents: agents.clone(),
    }
}

/// Messages before the first new one, to find the agent message it answers.
const LOOKBACK_MESSAGES: i64 = 50;
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
/// message's sender and normalized content
type FactRow = (
    String,
    i64,
    String,
    String,
    Option<Value>,
    Option<String>,
    Option<Value>,
);

/// status, owner, owner display name, lease expiry, updated_at
type RunRow = (String, String, Option<String>, Option<String>, String);

const MESSAGE_FACTS_SQL: &str = "
SELECT m.message_id::text, m.conversation_sequence, m.sender_account_id, m.created_at::text,
       m.attention_content, ref.sender_account_id, ref.attention_content
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
            account_id: None,
            agent_name: non_empty(&mention["label"])
                .map(|label| label.trim_start_matches('@').to_string()),
        })
}

/// Facts for messages after `after`, ascending. `flagged` holds the ids the
/// run input marks as addressed to or answered by an agent.
async fn message_facts(
    pool: &PgPool,
    config: &SystemAgentConfig,
    conversation_id: Uuid,
    after: i64,
    flagged: &HashSet<String>,
) -> Result<Vec<MessageFact>, sqlx_core::Error> {
    let rows: Vec<FactRow> = query_as(MESSAGE_FACTS_SQL)
        .bind(conversation_id)
        .bind(after)
        .bind(MESSAGE_FETCH)
        .fetch_all(pool)
        .await?;
    let not_people = [
        config.account_id.as_str(),
        crate::system_account::SYSTEM_ACCOUNT_ID,
    ];
    let mut facts: Vec<MessageFact> = rows
        .into_iter()
        .filter_map(
            |(id, sequence, sender, created_at, content, ref_sender, ref_content)| {
                let created_at = parse_pg_timestamp(&created_at)?.with_timezone(&Utc);
                let content = content.unwrap_or(Value::Null);
                let person = !not_people.contains(&sender.as_str());
                let agent = person.then(|| agent_message(&sender, &content)).flatten();
                let replied_to_agent = ref_sender
                    .zip(ref_content)
                    .and_then(|(sender, content)| agent_message(&sender, &content))
                    .map(|agent| agent.owner);
                let addressed_owner = replied_to_agent
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

/// Person-agent runs in the session, newest first, and an exchange still
/// waiting on a reply. Requesters are the conversation's members, which keeps
/// the lookup on the runs' requester and session index.
async fn open_work(pool: &PgPool, candidate: &Candidate) -> Result<Work, sqlx_core::Error> {
    let rows: Vec<RunRow> = query_as(
        "SELECT run.status, run.owner_account_id, account.display_name, run.lease_expires_at,
                run.updated_at
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
        .map(|(status, owner, owner_name, lease, updated)| RunFact {
            status,
            owner: Owner {
                account_id: Some(owner),
                agent_name: possessive(owner_name),
            },
            lease_expires_at: instant(lease.as_deref()),
            updated_at: instant(Some(&updated)),
        })
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

/// Message ids the run input already marks as for an agent.
fn flagged_ids(input: &Value) -> HashSet<String> {
    input["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| message["addressesAgent"] == true || message["answeredByAgent"] == true)
        .filter_map(|message| message["messageId"].as_str().map(str::to_string))
        .collect()
}

async fn save(pool: &PgPool, conversation_id: Uuid, patch: &Value) -> Result<(), sqlx_core::Error> {
    query(
        "UPDATE cloud_pip_conversation_state
         SET hooks_fired = (hooks_fired - $3) || $2::jsonb, updated_at = now()
         WHERE conversation_id = $1 AND active_run_id IS NULL",
    )
    .bind(conversation_id)
    .bind(patch)
    .bind(DEFERRED_KEY)
    .execute(pool)
    .await?;
    Ok(())
}

/// The run input for a candidate, after deciding who owns its new messages.
/// A stalled task comes back with the cursor rewound to the task's first
/// message, so the System agent reads the deferred messages as new.
pub(super) async fn prepare(
    pool: &PgPool,
    config: &SystemAgentConfig,
    candidate: &Candidate,
) -> Result<(Candidate, Value, Gate), sqlx_core::Error> {
    let mut input = build_input(pool, config, candidate).await?;
    let stored = Deferral::read(&candidate.hooks_fired);
    let stepped_in = SteppedIn::read(&candidate.hooks_fired);
    // A pending plan discussion's messages are read too, for its silence.
    let discussion = PlanDiscussion::read(&candidate.hooks_fired);
    let start = [
        Some(candidate.seen_sequence),
        stored.as_ref().map(|task| task.from_sequence),
        discussion.map(|discussion| discussion.from_sequence),
    ]
    .into_iter()
    .flatten()
    .min()
    .unwrap_or_default()
        - LOOKBACK_MESSAGES;
    let flagged = flagged_ids(&input);
    let messages = message_facts(
        pool,
        config,
        candidate.conversation_id,
        start.max(0),
        &flagged,
    )
    .await?;
    let work = open_work(pool, candidate).await?;
    let clock = Clock {
        now: Utc::now(),
        stall: config.stall_window(),
    };
    let working = work.open_owner(clock.now, clock.stall).is_some();
    let stepped_in_through = stepped_in.as_ref().map_or(0, |stepped| stepped.through);
    let assessment = assess(
        stored.clone(),
        stepped_in_through,
        candidate.seen_sequence,
        &messages,
        &work,
        &clock,
    );
    // An unreadable `deferred` value is cleared too, so it never keeps waking
    // the sweep.
    if let Some(patch) = state_patch(
        candidate.hooks_fired.get(DEFERRED_KEY).is_some(),
        &assessment.outcome,
        candidate.latest_sequence,
    ) {
        save(pool, candidate.conversation_id, &patch).await?;
    }
    let mut gate = gate(
        &assessment.outcome,
        candidate.seen_sequence,
        &messages,
        working,
        &assessment.agents,
    );
    let mut candidate = candidate.clone();
    if let Outcome::Stalled(task) = &assessment.outcome {
        candidate.seen_sequence = task.from_sequence.min(candidate.seen_sequence);
        input = build_input(pool, config, &candidate).await?;
        mark(&mut input, &Default::default(), &assessment.agents);
        step_in(&mut input, &task.owner);
        return Ok((candidate, input, gate));
    }
    mark(&mut input, &assessment.owned, &assessment.agents);
    // A retried step-in run still says it is picking the task up.
    if let Some(stepped) = stepped_in.filter(|stepped| {
        candidate.seen_sequence < stepped.through && retried_step_in(&input, stepped.through)
    }) {
        step_in(&mut input, &stepped.owner);
        gate.stepping_in = true;
    }
    Ok((candidate, input, gate))
}

fn retried_step_in(input: &Value, through: i64) -> bool {
    input["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|message| {
            message["isNew"] == true
                && message["sequence"]
                    .as_i64()
                    .is_some_and(|sequence| sequence <= through)
        })
}
