//! One owner per task. When a person's agent is working on something in a
//! conversation, the System agent does not plan alongside it; it leaves those
//! messages to that agent and steps in only once the agent stalls.
//!
//! A deferred task lives in the sweep row's `hooks_fired` under `deferred`
//! until the owning agent replies (the task is done) or stalls (the System
//! agent handles the deferred messages itself, with one line saying so).

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// How often a waiting task is checked again.
pub(super) const RECHECK_SECONDS: i64 = 60;
/// A lease this far past its expiry means the run stopped.
const LEASE_GRACE_SECONDS: i64 = 60;
/// An open run older than this is stuck, not working on new messages.
const OPEN_RUN_HORIZON_MINUTES: i64 = 60;
/// The sweep row keys this module owns.
pub(super) const DEFERRED_KEY: &str = "deferred";
pub(super) const STEPPED_IN_KEY: &str = "steppedIn";

/// The agent that owns a task: its owner's account and the name people see.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Owner {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
}

impl Owner {
    pub(super) fn label(&self) -> &str {
        self.agent_name.as_deref().unwrap_or("The agent")
    }
}

/// A task the System agent left to a person's agent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Deferral {
    /// Messages after this sequence belong to the task.
    pub from_sequence: i64,
    pub last_human_sequence: i64,
    /// When the task's first message arrived; runs that ended before it are
    /// not this task's.
    pub since: DateTime<Utc>,
    pub last_human_at: DateTime<Utc>,
    #[serde(default)]
    pub owner: Owner,
    pub check_after: DateTime<Utc>,
}

impl Deferral {
    pub(super) fn read(hooks_fired: &Value) -> Option<Self> {
        serde_json::from_value(hooks_fired.get(DEFERRED_KEY)?.clone()).ok()
    }
}

/// The messages the System agent took over from a stalled agent, so a retried
/// step-in run still says so.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SteppedIn {
    pub through: i64,
    #[serde(default)]
    pub owner: Owner,
}

impl SteppedIn {
    pub(super) fn read(hooks_fired: &Value) -> Option<Self> {
        serde_json::from_value(hooks_fired.get(STEPPED_IN_KEY)?.clone()).ok()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Delivery {
    Processing,
    Complete,
    Failed,
}

/// A message a person's agent wrote.
#[derive(Clone, Debug)]
pub(super) struct AgentMessage {
    pub owner: Owner,
    /// A question, a processing row, or an exchange waiting on someone.
    pub waiting: bool,
    pub delivery: Delivery,
}

/// What the ownership check needs to know about one chat message.
#[derive(Clone, Debug)]
pub(super) struct MessageFact {
    pub sequence: i64,
    pub created_at: DateTime<Utc>,
    /// Written by a person's agent.
    pub agent: Option<AgentMessage>,
    /// A person's own words (not an agent, the System agent, or a notice).
    pub human: bool,
    /// The agent this message mentions, replies to, quotes, or asked to run.
    pub addressed_owner: Option<Owner>,
}

/// One person-agent run in the conversation's session.
#[derive(Clone, Debug)]
pub(super) struct RunFact {
    pub status: String,
    pub owner: Owner,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

impl RunFact {
    fn is_open(&self) -> bool {
        matches!(self.status.as_str(), "queued" | "leased" | "running")
    }

    fn is_executing(&self) -> bool {
        matches!(self.status.as_str(), "leased" | "running")
    }

    /// Running with a live lease: the agent is working right now.
    fn is_alive(&self, now: DateTime<Utc>, stall: Duration) -> bool {
        self.is_executing()
            && match self.lease_expires_at {
                Some(lease) => lease > now - Duration::seconds(LEASE_GRACE_SECONDS),
                None => self.updated_at.is_some_and(|updated| updated > now - stall),
            }
    }

    /// Ended without a reply: failed, cancelled, or its lease ran out.
    fn ended_badly(&self, now: DateTime<Utc>, stall: Duration) -> bool {
        matches!(self.status.as_str(), "failed" | "cancelled")
            || (self.is_executing() && !self.is_alive(now, stall))
    }
}

/// Person-agent work open in the conversation.
#[derive(Clone, Debug, Default)]
pub(super) struct Work {
    pub runs: Vec<RunFact>,
    /// The owner of an agent exchange still waiting on a reply.
    pub pending_exchange: Option<Owner>,
}

impl Work {
    /// The owner of work still open now, which every new message defers to.
    fn open_owner(&self, now: DateTime<Utc>) -> Option<Owner> {
        let horizon = now - Duration::minutes(OPEN_RUN_HORIZON_MINUTES);
        self.runs
            .iter()
            .find(|run| run.is_open() && run.updated_at.is_none_or(|updated| updated > horizon))
            .map(|run| run.owner.clone())
            .or_else(|| self.pending_exchange.clone())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Outcome {
    /// No agent owns anything new: plan as usual.
    Free,
    /// An agent owns the task and may still reply.
    Waiting(Deferral),
    /// The owning agent replied; its task is done.
    Replied,
    /// The owning agent stalled; the System agent takes the task.
    Stalled(Deferral),
}

#[derive(Clone, Debug)]
pub(super) struct Assessment {
    pub outcome: Outcome,
    /// New messages that belong to an agent's task.
    pub owned: BTreeSet<i64>,
    /// Messages written by a person's agent, with that agent's name.
    pub agents: BTreeMap<i64, Option<String>>,
}

pub(super) struct Clock {
    pub now: DateTime<Utc>,
    pub stall: Duration,
}

/// Decides who owns the new messages (after `seen`) and whether a deferred
/// task is still waiting, answered, or stalled. `messages` are ascending and
/// start early enough to show the agent message before the first new one.
pub(super) fn assess(
    stored: Option<Deferral>,
    stepped_in_through: i64,
    seen: i64,
    messages: &[MessageFact],
    work: &Work,
    clock: &Clock,
) -> Assessment {
    let had_task = stored.is_some();
    let mut task = stored.filter(|task| !replied(task, messages));
    let resolved = had_task && task.is_none();
    let open_owner = work.open_owner(clock.now);
    let mut last_agent: Option<(&MessageFact, &AgentMessage)> = None;
    let mut owned = BTreeSet::new();
    let mut agents = BTreeMap::new();
    for message in messages {
        if let Some(agent) = &message.agent {
            agents.insert(message.sequence, agent.owner.agent_name.clone());
            last_agent = Some((message, agent));
            continue;
        }
        if message.sequence <= seen.max(stepped_in_through) || !message.human {
            continue;
        }
        let answers_agent = last_agent.filter(|(asked, agent)| {
            agent.waiting
                && asked.sequence > stepped_in_through
                && message.created_at - asked.created_at <= clock.stall
        });
        let signal = message
            .addressed_owner
            .clone()
            .or_else(|| answers_agent.map(|(_, agent)| agent.owner.clone()))
            .or_else(|| open_owner.clone());
        match (&mut task, signal) {
            (Some(task), Some(owner)) => {
                task.last_human_sequence = message.sequence;
                task.last_human_at = message.created_at;
                if task.owner.account_id.is_none() && task.owner.agent_name.is_none() {
                    task.owner = owner;
                }
            }
            (Some(_), None) => {}
            (None, Some(owner)) => {
                task = Some(Deferral {
                    from_sequence: message.sequence - 1,
                    last_human_sequence: message.sequence,
                    since: message.created_at,
                    last_human_at: message.created_at,
                    owner,
                    check_after: clock.now,
                });
            }
            (None, None) => continue,
        }
        owned.insert(message.sequence);
    }
    let outcome = match task {
        Some(task) => decide(task, messages, work, clock),
        None if resolved => Outcome::Replied,
        None => Outcome::Free,
    };
    Assessment {
        outcome,
        owned,
        agents,
    }
}

/// Whether the owning agent posted a finished reply after the task's last
/// human message.
fn replied(task: &Deferral, messages: &[MessageFact]) -> bool {
    owner_messages_after(task, messages).any(|agent| agent.delivery == Delivery::Complete)
}

fn owner_messages_after<'a>(
    task: &'a Deferral,
    messages: &'a [MessageFact],
) -> impl Iterator<Item = &'a AgentMessage> + 'a {
    messages
        .iter()
        .filter(move |message| message.sequence > task.last_human_sequence)
        .filter_map(|message| message.agent.as_ref())
        .filter(move |agent| {
            task.owner.account_id.is_none() || agent.owner.account_id == task.owner.account_id
        })
}

fn decide(mut task: Deferral, messages: &[MessageFact], work: &Work, clock: &Clock) -> Outcome {
    if replied(&task, messages) {
        return Outcome::Replied;
    }
    let runs: Vec<&RunFact> = work
        .runs
        .iter()
        .filter(|run| run.is_open() || run.updated_at.is_some_and(|at| at >= task.since))
        .collect();
    let newest = runs.iter().max_by_key(|run| run.updated_at);
    // A run that finished after the last human message answered the task.
    if newest.is_some_and(|run| {
        run.status == "completed" && run.updated_at.is_some_and(|at| at >= task.last_human_at)
    }) {
        return Outcome::Replied;
    }
    // Never step in while the agent is visibly working.
    if runs.iter().any(|run| run.is_alive(clock.now, clock.stall)) {
        task.check_after = clock.now + Duration::seconds(RECHECK_SECONDS);
        return Outcome::Waiting(task);
    }
    let failed_reply =
        owner_messages_after(&task, messages).any(|agent| agent.delivery == Delivery::Failed);
    let run_ended_badly = newest.is_some_and(|run| run.ended_badly(clock.now, clock.stall));
    let window_passed = clock.now - task.last_human_at >= clock.stall;
    if failed_reply || run_ended_badly || window_passed {
        return Outcome::Stalled(task);
    }
    task.check_after = clock.now + Duration::seconds(RECHECK_SECONDS);
    Outcome::Waiting(task)
}

/// The sweep row change for an outcome: the keys to drop and the patch to
/// merge, or None when the row stays as it is.
pub(super) fn state_patch(
    had_deferral: bool,
    outcome: &Outcome,
    latest_sequence: i64,
) -> Option<Value> {
    match outcome {
        Outcome::Waiting(task) => Some(json!({ DEFERRED_KEY: task })),
        Outcome::Stalled(task) => Some(json!({
            STEPPED_IN_KEY: SteppedIn { through: latest_sequence, owner: task.owner.clone() },
        })),
        Outcome::Free | Outcome::Replied if had_deferral => Some(json!({})),
        Outcome::Free | Outcome::Replied => None,
    }
}

/// Marks agents' messages and messages that belong to an agent's task, so the
/// model reads them as context and the free check skips them.
pub(super) fn mark(
    input: &mut Value,
    owned: &BTreeSet<i64>,
    agents: &BTreeMap<i64, Option<String>>,
) {
    for message in input["messages"].as_array_mut().into_iter().flatten() {
        let Some(sequence) = message["sequence"].as_i64() else {
            continue;
        };
        if owned.contains(&sequence) {
            message["agentOwned"] = json!(true);
        }
        if let Some(name) = agents.get(&sequence) {
            message["fromAgent"] = json!(true);
            if let Some(name) = name {
                message["agentName"] = json!(name);
            }
        }
    }
}

/// Hands the stalled agent's task to the System agent: every message in the
/// snapshot is the System agent's to act on, and the run says it is stepping in.
pub(super) fn step_in(input: &mut Value, owner: &Owner) {
    for message in input["messages"].as_array_mut().into_iter().flatten() {
        if let Some(message) = message.as_object_mut() {
            for key in ["addressesAgent", "answeredByAgent", "agentOwned"] {
                message.remove(key);
            }
        }
    }
    input["stepIn"] = json!({ "agentName": owner.label() });
}

/// The System agent's message, led by one line saying it is picking up a
/// stalled agent's task when the run is a step-in.
pub(super) fn with_step_in_line(input: &Value, text: &str) -> String {
    match input["stepIn"]["agentName"].as_str() {
        Some(name) => format!("{name} hasn't replied, so I'm picking this up.\n{text}"),
        None => text.to_string(),
    }
}

#[cfg(test)]
#[path = "ownership_tests.rs"]
mod tests;
