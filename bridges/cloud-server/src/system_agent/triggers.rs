//! When the System agent acts on its own. People plan with each other, and a
//! person's agent plans for them; the System agent is not a parallel planner.
//! It acts only when:
//!
//! - silence: a plan discussion nobody's agent took has gone quiet without a
//!   card,
//! - loop: agents went back and forth without progress,
//! - conflict: two plan cards overlap or disagree on the time of one plan,
//! - stall: the agent that owns a task stopped replying (see `ownership`).
//!
//! Card hooks (votes, reminders) and a member asking the System agent
//! directly still wake it, but plan talk alone never does until it is quiet.
//! Every trigger fires once: its marks join the sweep row's `hooks_fired`
//! when the run finishes, so a retried run still has it and a finished one
//! never repeats it.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::ownership_store::Gate;

/// The sweep row keys this module owns.
pub(super) const DISCUSSION_KEY: &str = "planDiscussion";
pub(super) const CHECK_AFTER_KEY: &str = "triggerCheckAfter";
pub(super) const CARDS_CHECKED_KEY: &str = "cardsCheckedAt";
/// The run input key holding the marks a finished run records.
const MARKS_KEY: &str = "triggerMarks";
/// How soon a trigger that had to wait is checked again.
pub(super) const RECHECK_SECONDS: i64 = 60;

/// Plan talk the System agent holds until the conversation goes quiet.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PlanDiscussion {
    /// Messages after this sequence belong to the discussion.
    pub from_sequence: i64,
    /// When its first message arrived; a card made since then covers it.
    pub since: DateTime<Utc>,
    pub check_after: DateTime<Utc>,
}

impl PlanDiscussion {
    pub(super) fn read(hooks_fired: &Value) -> Option<Self> {
        serde_json::from_value(hooks_fired.get(DISCUSSION_KEY)?.clone()).ok()
    }
}

/// A loop or a conflict worth one step-in.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Finding {
    /// What the run input shows the model, including `kind`.
    pub detail: Value,
    /// Merged into `hooks_fired` when the run finishes.
    pub marks: Value,
    /// The member to address when no card fits: the owner of the agent that
    /// started the task, or whoever made the other card.
    pub ask: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Trigger {
    /// The owning agent stalled; `ownership` already set up the input.
    Stall,
    /// A member asked the System agent directly.
    Request {
        rewind_to: Option<i64>,
    },
    /// A plan discussion went quiet.
    Silence {
        from_sequence: i64,
        quiet: Duration,
    },
    Loop(Finding),
    Conflict(Finding),
    /// Only card hooks or reminders woke the System agent.
    Cards,
}

impl Trigger {
    /// The cursor the run input should start from, when it must reach back to
    /// the discussion's first message.
    pub(super) fn rewind_to(&self) -> Option<i64> {
        match self {
            Self::Request { rewind_to } => *rewind_to,
            Self::Silence { from_sequence, .. } => Some(*from_sequence),
            _ => None,
        }
    }
}

/// Everything one sweep pass knows when it decides whether to act.
pub(super) struct PassFacts<'a> {
    pub now: DateTime<Utc>,
    pub silence: Duration,
    pub seen_sequence: i64,
    pub hooks_fired: &'a Value,
    /// Hook names in the run input (`new_messages`, `card_changed`, ...).
    pub hooks: Vec<String>,
    /// New messages from people that could be about a plan, for no agent.
    pub plan_talk: bool,
    /// A new message from a person addresses the System agent itself.
    pub asks_system_agent: bool,
    pub gate: &'a Gate,
    /// When the newest live card in the conversation was created.
    pub newest_card_created_at: Option<DateTime<Utc>>,
    pub found_loop: Option<Finding>,
    pub found_conflict: Option<Finding>,
}

#[derive(Debug)]
pub(super) struct PassPlan {
    pub run: Option<Trigger>,
    /// Saved on the sweep row now, whether or not a run follows.
    pub patch: Map<String, Value>,
    /// Recorded when the run finishes.
    pub marks: Map<String, Value>,
}

/// Decides whether this pass runs the System agent and why.
pub(super) fn decide(facts: PassFacts<'_>) -> PassPlan {
    let gate = facts.gate;
    let mut patch = Map::new();
    let mut marks = Map::new();
    let stored = PlanDiscussion::read(facts.hooks_fired);
    // A card made since the discussion began, an agent taking a task, or an
    // agent speaking up, updating its answer, or finishing a task all mean
    // someone is on it. Only new plan talk after that starts a new discussion.
    let resolved = |discussion: &PlanDiscussion| {
        gate.agent_task
            || gate
                .newest_agent_sequence
                .is_some_and(|sequence| sequence > discussion.from_sequence)
            || [
                gate.last_agent_activity_at,
                gate.last_finished_run_started_at,
            ]
            .into_iter()
            .flatten()
            .any(|at| at >= discussion.since)
            || facts
                .newest_card_created_at
                .is_some_and(|created| created >= discussion.since)
    };
    let mut discussion = stored.clone().filter(|discussion| !resolved(discussion));
    if discussion.is_none() && facts.plan_talk {
        discussion = Some(PlanDiscussion {
            from_sequence: facts.seen_sequence,
            since: gate.first_new_human_at.unwrap_or(facts.now),
            check_after: facts.now,
        })
        .filter(|discussion| !resolved(discussion));
    }
    let quiet = gate
        .last_human_at
        .map_or(facts.silence, |last| facts.now - last);
    let silent = quiet >= facts.silence;

    let run = if gate.stepping_in {
        Some(Trigger::Stall)
    } else if facts.asks_system_agent && !gate.agent_busy {
        Some(Trigger::Request {
            rewind_to: discussion
                .as_ref()
                .map(|discussion| discussion.from_sequence),
        })
    } else if gate.agent_busy {
        None
    } else if let Some(finding) = facts.found_loop.clone() {
        Some(Trigger::Loop(finding))
    } else if let Some(finding) = facts.found_conflict.clone() {
        Some(Trigger::Conflict(finding))
    } else if let Some(discussion) = discussion.as_ref().filter(|_| silent) {
        Some(Trigger::Silence {
            from_sequence: discussion.from_sequence,
            quiet,
        })
    } else if facts
        .hooks
        .iter()
        .any(|hook| hook == "card_changed" || hook.starts_with("t_minus_"))
    {
        Some(Trigger::Cards)
    } else {
        None
    };

    // The discussion: done once a run reads it, otherwise kept until quiet.
    let consumed = matches!(
        run,
        Some(Trigger::Stall | Trigger::Request { .. } | Trigger::Silence { .. })
    );
    match discussion {
        Some(_) if consumed => {
            marks.insert(DISCUSSION_KEY.into(), Value::Null);
        }
        Some(mut discussion) => {
            discussion.check_after = match gate.last_human_at {
                Some(last) if !silent => last + facts.silence,
                _ => facts.now + Duration::seconds(RECHECK_SECONDS),
            };
            patch.insert(DISCUSSION_KEY.into(), json!(discussion));
        }
        None if stored.is_some() || facts.hooks_fired.get(DISCUSSION_KEY).is_some() => {
            patch.insert(DISCUSSION_KEY.into(), Value::Null);
        }
        None => {}
    }
    // A loop or conflict that has to wait for an agent, or for another run.
    let chosen = |finding: &Finding| match &run {
        Some(Trigger::Loop(chosen) | Trigger::Conflict(chosen)) => chosen == finding,
        _ => false,
    };
    let waiting = [&facts.found_loop, &facts.found_conflict]
        .into_iter()
        .flatten()
        .any(|finding| !chosen(finding));
    if waiting {
        let at = facts.now + Duration::seconds(RECHECK_SECONDS);
        patch.insert(CHECK_AFTER_KEY.into(), json!(at));
    } else if facts
        .hooks_fired
        .get(CHECK_AFTER_KEY)
        .is_some_and(|value| !value.is_null())
    {
        patch.insert(CHECK_AFTER_KEY.into(), Value::Null);
    }
    if let Some(Trigger::Loop(finding) | Trigger::Conflict(finding)) = &run {
        if let Some(found) = finding.marks.as_object() {
            marks.extend(found.clone());
        }
    }
    PassPlan { run, patch, marks }
}

/// Tells the model which trigger woke it, and keeps what the run records when
/// it finishes. Only the System agent's own request, a quiet discussion, and
/// a stalled task are plan talk to act on; for any other trigger the chat is
/// context, so plan talk still waits for its silence.
pub(super) fn apply(input: &mut Value, trigger: &Trigger, marks: Map<String, Value>) {
    let detail = match trigger {
        Trigger::Stall => json!({
            "kind": "stall",
            "agentName": input["stepIn"]["agentName"].clone(),
            "reason": input["stepIn"]["reason"].clone(),
        }),
        Trigger::Request { .. } => json!({"kind": "request"}),
        Trigger::Silence { quiet, .. } => json!({
            "kind": "silence",
            "quietMinutes": quiet.num_minutes(),
        }),
        Trigger::Loop(finding) | Trigger::Conflict(finding) => finding.detail.clone(),
        Trigger::Cards => Value::Null,
    };
    if !detail.is_null() {
        input["trigger"] = detail;
        let ask = match trigger {
            Trigger::Stall => input["stepIn"]["ownerAccountId"]
                .as_str()
                .map(str::to_string),
            Trigger::Silence { .. } => first_speaker(input),
            Trigger::Loop(finding) | Trigger::Conflict(finding) => finding.ask.clone(),
            Trigger::Request { .. } | Trigger::Cards => None,
        };
        if let Some(mut ask) = ask.and_then(|account_id| addressee(input, &account_id)) {
            // A loop goes back to the agent that owns the task; everything
            // else to a person who can decide.
            let agent = matches!(trigger, Trigger::Loop(_)) && ask["agentHandle"].is_string();
            ask["mention"] = ask[if agent { "agentHandle" } else { "handle" }].clone();
            input["trigger"]["ask"] = ask;
        }
    }
    if matches!(
        trigger,
        Trigger::Loop(_) | Trigger::Conflict(_) | Trigger::Cards
    ) {
        if let Some(hooks) = input["hooks"].as_array_mut() {
            hooks.retain(|hook| hook["name"] != "new_messages");
        }
        for message in input["messages"].as_array_mut().into_iter().flatten() {
            message["isNew"] = json!(false);
        }
    }
    if !marks.is_empty() {
        input[MARKS_KEY] = Value::Object(marks);
    }
}

/// The first person who spoke in the discussion the run reads as new.
fn first_speaker(input: &Value) -> Option<String> {
    input["messages"]
        .as_array()?
        .iter()
        .find(|message| {
            message["isNew"] == true
                && message["fromAgent"] != true
                && message["fromSystemAgent"] != true
        })
        .and_then(|message| message["senderId"].as_str().map(str::to_string))
}

/// A listed member's handles, for the trigger's `ask`.
fn addressee(input: &Value, account_id: &str) -> Option<Value> {
    let member = input["members"]
        .as_array()?
        .iter()
        .find(|member| member["participantId"] == account_id && member["isSystemAgent"] != true)?;
    Some(json!({
        "participantId": account_id,
        "handle": member["handle"],
        "agentHandle": member["agentHandle"],
    }))
}

/// What a finished (or refused) run records in `hooks_fired`: the reminders
/// it was offered and its trigger's marks.
pub(super) fn finish_marks(input: &Value) -> Value {
    let mut hooks = super::store::offered_reminders(input);
    if let (Some(hooks), Some(marks)) = (hooks.as_object_mut(), input[MARKS_KEY].as_object()) {
        hooks.extend(marks.clone());
    }
    hooks
}

/// Lower-case words of at least three letters, without the most common
/// filler, for comparing short texts.
pub(super) fn word_set(text: &str) -> std::collections::BTreeSet<String> {
    const FILLER: [&str; 12] = [
        "the", "and", "for", "with", "our", "this", "that", "are", "you", "let", "lets", "can",
    ];
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| word.chars().count() >= 3 && !FILLER.contains(word))
        .map(str::to_string)
        .collect()
}

/// Shared words over all words, from 0 to 1.
pub(super) fn similarity(
    left: &std::collections::BTreeSet<String>,
    right: &std::collections::BTreeSet<String>,
) -> f64 {
    let union = left.union(right).count();
    if union == 0 {
        return 0.0;
    }
    left.intersection(right).count() as f64 / union as f64
}

#[cfg(test)]
#[path = "triggers_tests.rs"]
mod tests;
