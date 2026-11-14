//! Runs the ownership check on what `ownership_facts` loads, applies its
//! outcome to the run input, and keeps the deferred task in the sweep row.

use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::config::SystemAgentConfig;
use super::input::{build_input, Candidate};
use super::ownership::{
    assess, mark, state_patch, step_in, Clock, Deferral, MessageFact, Outcome, SteppedIn, Work,
    DEFERRED_KEY,
};
use super::ownership_facts::{message_facts, open_work};
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
    /// The last time a person's agent wrote or updated a message in place.
    pub last_agent_activity_at: Option<DateTime<Utc>>,
    /// When the newest finished person-agent run was started; one started
    /// during plan talk took it up and ended with a result.
    pub last_finished_run_started_at: Option<DateTime<Utc>>,
    /// Messages written by a person's agent, with that agent's name.
    pub agents: BTreeMap<i64, Option<String>>,
}

fn gate(
    outcome: &Outcome,
    seen: i64,
    messages: &[MessageFact],
    work: &Work,
    working: bool,
    agents: &BTreeMap<i64, Option<String>>,
) -> Gate {
    let humans = messages.iter().filter(|message| message.human);
    let agent_messages = messages.iter().filter_map(|message| {
        let agent = message.agent.as_ref()?;
        Some(
            agent
                .changed_at
                .unwrap_or(message.created_at)
                .max(message.created_at),
        )
    });
    let finished_runs = work
        .runs
        .iter()
        .filter(|run| run.status == "completed")
        .filter_map(|run| run.created_at);
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
        last_agent_activity_at: agent_messages.max(),
        last_finished_run_started_at: finished_runs.max(),
        agents: agents.clone(),
    }
}

/// Messages before the first new one, to find the agent message it answers.
const LOOKBACK_MESSAGES: i64 = 50;

/// The member whose agent goes by `name`, for a task whose owner was only
/// named: the agent's handle (`@KordiMaya`) or "Maya's agent".
fn owner_by_agent_name(input: &Value, name: &str) -> Option<String> {
    let wanted = super::mentions::mention_handle(name).to_lowercase();
    let matches: Vec<&str> = input["members"]
        .as_array()?
        .iter()
        .filter(|member| member["isSystemAgent"] != true)
        .filter(|member| {
            let display = member["displayName"].as_str().unwrap_or_default();
            let agent = member["agentHandle"].as_str().unwrap_or_default();
            [
                agent.trim_start_matches('@').to_string(),
                super::mentions::mention_handle(&format!("{display}s agent")),
                super::mentions::mention_handle(&format!("{display}s Kordi")),
            ]
            .iter()
            .any(|candidate| !candidate.is_empty() && candidate.to_lowercase() == wanted)
        })
        .filter_map(|member| member["participantId"].as_str())
        .collect();
    match matches.as_slice() {
        [account_id] => Some(account_id.to_string()),
        _ => None,
    }
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

/// Message ids the run input marks as asking the System agent itself.
fn system_agent_request_ids(input: &Value) -> HashSet<String> {
    input["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| message["addressesSystemAgent"] == true)
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
    let requests = system_agent_request_ids(&input);
    let messages =
        message_facts(pool, config, candidate, start.max(0), &flagged, &requests).await?;
    let work = open_work(pool, candidate).await?;
    let clock = Clock {
        now: Utc::now(),
        stall: config.stall_window(),
    };
    let working = work.open_owner(clock.now, clock.stall).is_some();
    let stepped_in_through = stepped_in.as_ref().map_or(0, |stepped| stepped.through);
    let mut assessment = assess(
        stored.clone(),
        stepped_in_through,
        candidate.seen_sequence,
        &messages,
        &work,
        &clock,
    );
    // A stalled task whose agent was only named keeps its owner's account, so
    // every later step-in record and `ask` still has it.
    if let Outcome::Stalled(task) = &mut assessment.outcome {
        if task.owner.account_id.is_none() {
            let name = task.owner.agent_name.clone().unwrap_or_default();
            task.owner.account_id = owner_by_agent_name(&input, &name);
        }
    }
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
        &work,
        working,
        &assessment.agents,
    );
    let mut candidate = candidate.clone();
    if let Outcome::Stalled(task) = &assessment.outcome {
        candidate.seen_sequence = task.from_sequence.min(candidate.seen_sequence);
        input = build_input(pool, config, &candidate).await?;
        mark(&mut input, &Default::default(), &assessment.agents);
        step_in(&mut input, &task.owner, task.cause.unwrap_or_default());
        return Ok((candidate, input, gate));
    }
    mark(&mut input, &assessment.owned, &assessment.agents);
    // A retried step-in run still says it is picking the task up.
    if let Some(stepped) = stepped_in.filter(|stepped| {
        candidate.seen_sequence < stepped.through && retried_step_in(&input, stepped.through)
    }) {
        step_in(&mut input, &stepped.owner, stepped.cause);
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
