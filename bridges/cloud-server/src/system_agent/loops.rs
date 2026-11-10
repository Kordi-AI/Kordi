//! Agents going back and forth without progress: a task that used up its
//! collaboration requests, several rounds between the same two agents with no
//! card since, or agents repeating nearly the same message.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use super::triggers::{similarity, word_set, Finding};

/// Rounds between the same two agents, with no card since, that make a loop.
pub(super) const LOOP_ROUNDS: usize = 4;
/// Near-identical agent messages that make a loop.
pub(super) const REPEATS: usize = 3;
/// How alike two agent messages must be to count as the same.
const SAME_MESSAGE: f64 = 0.8;
const ROOT_PREFIX: &str = "loop:root:";
const PAIR_PREFIX: &str = "loop:pair:";
const REPEAT_KEY: &str = "loop:repeat";

/// One collaboration request between two people's agents in the conversation.
#[derive(Clone, Debug)]
pub(super) struct ExchangeFact {
    pub root_run_id: String,
    pub from_account: String,
    pub from_agent: String,
    pub to_account: String,
    pub to_agent: String,
    pub created_at: DateTime<Utc>,
}

fn pair_key(exchange: &ExchangeFact) -> String {
    let (a, b) = if exchange.from_account <= exchange.to_account {
        (&exchange.from_account, &exchange.to_account)
    } else {
        (&exchange.to_account, &exchange.from_account)
    };
    format!("{PAIR_PREFIX}{a}|{b}")
}

fn agent_names<'a>(exchanges: impl Iterator<Item = &'a ExchangeFact>) -> Vec<String> {
    let names: BTreeSet<&str> = exchanges
        .flat_map(|exchange| [exchange.from_agent.as_str(), exchange.to_agent.as_str()])
        .collect();
    names.into_iter().map(str::to_string).collect()
}

fn instant(value: Option<&Value>) -> Option<DateTime<Utc>> {
    value
        .and_then(Value::as_str)
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|at| at.with_timezone(&Utc))
}

/// The first loop not stepped into yet. `exchanges` are ascending;
/// `last_card_change` is when a live card last changed (progress);
/// `messages` is the run input's messages.
pub(super) fn find_loop(
    exchanges: &[ExchangeFact],
    last_card_change: Option<DateTime<Utc>>,
    messages: &[Value],
    hooks_fired: &Value,
    request_limit: usize,
) -> Option<Finding> {
    request_limit_loop(exchanges, hooks_fired, request_limit)
        .or_else(|| rounds_loop(exchanges, last_card_change, hooks_fired))
        .or_else(|| repeated_messages(messages, hooks_fired))
}

fn request_limit_loop(
    exchanges: &[ExchangeFact],
    hooks_fired: &Value,
    request_limit: usize,
) -> Option<Finding> {
    let mut roots: BTreeMap<&str, Vec<&ExchangeFact>> = BTreeMap::new();
    for exchange in exchanges {
        roots
            .entry(exchange.root_run_id.as_str())
            .or_default()
            .push(exchange);
    }
    let (root, rounds) = roots.into_iter().find(|(root, rounds)| {
        rounds.len() >= request_limit && hooks_fired.get(format!("{ROOT_PREFIX}{root}")).is_none()
    })?;
    // The same rounds never count again as a loop between two agents.
    let mut marks = json!({ format!("{ROOT_PREFIX}{root}"): true });
    for exchange in &rounds {
        marks[pair_key(exchange)] = json!(exchange.created_at);
    }
    Some(Finding {
        detail: json!({
            "kind": "loop",
            "reason": "request_limit",
            "agents": agent_names(rounds.iter().copied()),
            "rounds": rounds.len(),
        }),
        marks,
        ask: rounds.first().map(|exchange| exchange.from_account.clone()),
    })
}

fn rounds_loop(
    exchanges: &[ExchangeFact],
    last_card_change: Option<DateTime<Utc>>,
    hooks_fired: &Value,
) -> Option<Finding> {
    let mut pairs: BTreeMap<String, Vec<&ExchangeFact>> = BTreeMap::new();
    for exchange in exchanges {
        if exchange.from_account != exchange.to_account {
            pairs.entry(pair_key(exchange)).or_default().push(exchange);
        }
    }
    pairs.into_iter().find_map(|(key, rounds)| {
        let floor = [instant(hooks_fired.get(&key)), last_card_change]
            .into_iter()
            .flatten()
            .max();
        let rounds: Vec<&ExchangeFact> = rounds
            .into_iter()
            .filter(|exchange| floor.is_none_or(|floor| exchange.created_at > floor))
            .collect();
        let newest = rounds.last()?.created_at;
        (rounds.len() >= LOOP_ROUNDS).then(|| Finding {
            detail: json!({
                "kind": "loop",
                "reason": "repeated_rounds",
                "agents": agent_names(rounds.iter().copied()),
                "rounds": rounds.len(),
            }),
            marks: json!({ key: newest }),
            ask: rounds.first().map(|exchange| exchange.from_account.clone()),
        })
    })
}

fn repeated_messages(messages: &[Value], hooks_fired: &Value) -> Option<Finding> {
    let after = hooks_fired
        .get(REPEAT_KEY)
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let agent_messages: Vec<(i64, String, BTreeSet<String>, Option<String>)> = messages
        .iter()
        .filter(|message| message["fromAgent"] == true)
        .filter_map(|message| {
            let sequence = message["sequence"].as_i64().filter(|&s| s > after)?;
            let name = message["agentName"]
                .as_str()
                .or(message["senderName"].as_str())
                .unwrap_or("An agent");
            let words = word_set(message["text"].as_str().unwrap_or_default());
            let owner = message["senderId"].as_str().map(str::to_string);
            (!words.is_empty()).then(|| (sequence, name.to_string(), words, owner))
        })
        .collect();
    let through = agent_messages
        .iter()
        .map(|(sequence, ..)| *sequence)
        .max()?;
    agent_messages.iter().find_map(|(_, _, words, _)| {
        let same: Vec<_> = agent_messages
            .iter()
            .filter(|(_, _, other, _)| similarity(words, other) >= SAME_MESSAGE)
            .collect();
        (same.len() >= REPEATS).then(|| {
            let agents: BTreeSet<&str> = same.iter().map(|(_, name, ..)| name.as_str()).collect();
            Finding {
                detail: json!({
                    "kind": "loop",
                    "reason": "repeated_messages",
                    "agents": agents,
                    "rounds": same.len(),
                }),
                marks: json!({ REPEAT_KEY: through }),
                ask: same.first().and_then(|(.., owner)| owner.clone()),
            }
        })
    })
}
