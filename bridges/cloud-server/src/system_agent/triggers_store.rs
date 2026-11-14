//! Loads what the trigger check needs (live plan cards, agent exchanges),
//! decides whether this pass runs, and keeps the trigger state in the sweep
//! row's `hooks_fired`.

use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::cloud_agent_runtime::runs::exchanges::REQUEST_LIMIT;
use crate::plan_cards::store::parse_pg_timestamp;

use super::addressing;
use super::config::SystemAgentConfig;
use super::conflicts::{find_conflict, CardFact};
use super::input::{build_input, Candidate};
use super::loops::{find_loop, ExchangeFact};
use super::ownership::mark;
use super::ownership_store::Gate;
use super::triggers::{apply, decide, PassFacts, CARDS_CHECKED_KEY};

/// Exchanges older than this are history, not a loop in progress.
const LOOP_WINDOW_HOURS: i64 = 2;
const EXCHANGE_FETCH: i64 = 200;
const CARD_FETCH: i64 = 20;

/// event_id, title, start_at, end_at, created_at, updated_at, created_by
type CardRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
);

/// root run, requester agent's owner and name, target owner and name, created_at.
/// The target owner is empty for a question to a person, which is not an agent round.
type ExchangeRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
);

fn instant(value: &str) -> Option<DateTime<Utc>> {
    parse_pg_timestamp(value).map(|at| at.with_timezone(&Utc))
}

fn agent_name(name: Option<String>) -> String {
    name.map_or_else(|| "An agent".to_string(), |name| format!("{name}'s agent"))
}

async fn live_cards(
    pool: &PgPool,
    config: &SystemAgentConfig,
    candidate: &Candidate,
) -> Result<Vec<CardFact>, sqlx_core::Error> {
    let rows: Vec<CardRow> = query_as(concat!(
        "SELECT card.event_id, card.title, card.start_at::text, card.end_at::text,
                card.created_at::text, card.updated_at::text, card.created_by_account_id
         FROM cloud_plan_cards card
         WHERE card.conversation_id = $1 AND ",
        crate::plan_cards::live_plan_card_sql!(),
        " ORDER BY card.updated_at DESC LIMIT $2"
    ))
    .bind(candidate.conversation_id)
    .bind(CARD_FETCH)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(event_id, title, start, end, created, updated, by)| {
            Some(CardFact {
                event_id,
                title,
                start_at: start.as_deref().and_then(instant),
                end_at: end.as_deref().and_then(instant),
                created_at: instant(&created)?,
                updated_at: instant(&updated)?,
                by_system_agent: by == config.account_id,
                created_by: by,
            })
        })
        .collect())
}

/// Collaboration requests between people's agents in the conversation's
/// session, oldest first. Requesters are the conversation's members, which
/// keeps the lookup on the runs' requester and session index.
async fn recent_exchanges(
    pool: &PgPool,
    candidate: &Candidate,
) -> Result<Vec<ExchangeFact>, sqlx_core::Error> {
    let rows: Vec<ExchangeRow> = query_as(
        "SELECT exchange.root_run_id, parent.owner_account_id, requester.display_name,
                exchange.target_owner_id, target.display_name, exchange.created_at::text
         FROM cloud_agent_exchanges exchange
         JOIN cloud_agent_fallback_runs parent ON parent.run_id = exchange.parent_run_id
         LEFT JOIN cloud_accounts requester ON requester.account_id = parent.owner_account_id
         LEFT JOIN cloud_accounts target ON target.account_id = exchange.target_owner_id
         WHERE parent.session_id = $1
           AND exchange.target_owner_id IS NOT NULL
           AND exchange.created_at > now() - make_interval(hours => $3)
           AND parent.requester_account_id IN (
               SELECT member.account_id FROM cloud_chat_conversation_members member
               WHERE member.conversation_id = $2)
         ORDER BY exchange.created_at ASC
         LIMIT $4",
    )
    .bind(&candidate.legacy_session_id)
    .bind(candidate.conversation_id)
    .bind(LOOP_WINDOW_HOURS as i32)
    .bind(EXCHANGE_FETCH)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(root, from, from_name, to, to_name, created)| {
            Some(ExchangeFact {
                root_run_id: root,
                from_account: from,
                from_agent: agent_name(from_name),
                to_account: to?,
                to_agent: agent_name(to_name),
                created_at: instant(&created)?,
            })
        })
        .collect())
}

async fn save(
    pool: &PgPool,
    candidate: &Candidate,
    patch: Map<String, Value>,
) -> Result<(), sqlx_core::Error> {
    if patch.is_empty() {
        return Ok(());
    }
    query(
        "UPDATE cloud_pip_conversation_state
         SET hooks_fired = hooks_fired || $2::jsonb, updated_at = now()
         WHERE conversation_id = $1 AND active_run_id IS NULL",
    )
    .bind(candidate.conversation_id)
    .bind(Value::Object(patch))
    .execute(pool)
    .await?;
    Ok(())
}

/// A new message from a person, for no other agent, that addresses the
/// System agent itself.
fn asks_system_agent(input: &Value) -> bool {
    input["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|message| {
            message["isNew"] == true
                && message["addressesSystemAgent"] == true
                && message["fromSystemAgent"] != true
                && message["agentOwned"] != true
                && message["fromAgent"] != true
        })
}

/// Whether this pass runs the System agent, and the input it runs with.
/// Returns None when it stays quiet; the caller then moves the cursor past
/// the new messages (a held plan discussion keeps its own place).
pub(super) async fn plan(
    pool: &PgPool,
    config: &SystemAgentConfig,
    candidate: Candidate,
    input: Value,
    gate: Gate,
) -> Result<Option<(Candidate, Value)>, sqlx_core::Error> {
    let cards = live_cards(pool, config, &candidate).await?;
    let exchanges = recent_exchanges(pool, &candidate).await?;
    let hooks: Vec<String> = input["hooks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|hook| hook["name"].as_str().map(str::to_string))
        .collect();
    let messages = input["messages"].as_array().cloned().unwrap_or_default();
    let last_card_change = cards.iter().map(|card| card.updated_at).max();
    let found_loop = find_loop(
        &exchanges,
        last_card_change,
        &messages,
        &candidate.hooks_fired,
        REQUEST_LIMIT as usize,
    );
    let plan = decide(PassFacts {
        now: Utc::now(),
        silence: config.silence_window(),
        seen_sequence: candidate.seen_sequence,
        hooks_fired: &candidate.hooks_fired,
        hooks,
        plan_talk: addressing::new_human_messages(&input).next().is_some(),
        asks_system_agent: asks_system_agent(&input),
        gate: &gate,
        newest_card_created_at: cards.iter().map(|card| card.created_at).max(),
        found_loop,
        found_conflict: find_conflict(&cards, &candidate.hooks_fired),
        requests_only: super::membership::is_room_group(pool, candidate.conversation_id).await?,
    });
    let mut patch = plan.patch;
    // Cards are checked for conflicts up to their newest change, so the sweep
    // stops looking at them until one changes again.
    if let Some(changed) = last_card_change {
        let checked = json!(changed);
        if candidate.hooks_fired.get(CARDS_CHECKED_KEY) != Some(&checked) {
            patch.insert(CARDS_CHECKED_KEY.into(), checked);
        }
    }
    save(pool, &candidate, patch).await?;
    let Some(trigger) = plan.run else {
        return Ok(None);
    };
    let mut candidate = candidate;
    let mut input = input;
    if let Some(from) = trigger
        .rewind_to()
        .filter(|from| *from < candidate.seen_sequence)
    {
        candidate.seen_sequence = from;
        input = build_input(pool, config, &candidate).await?;
        mark(&mut input, &Default::default(), &gate.agents);
    }
    apply(&mut input, &trigger, plan.marks);
    if super::triggers::allows_workflows(&input) {
        input["replyMode"] = json!("semantic");
    }
    Ok(Some((candidate, input)))
}
