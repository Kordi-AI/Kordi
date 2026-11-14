//! Sweep state, run creation and run completion for the System agent.
//!
//! The sweep copies the digest worker's shape: a bounded batch of dirty
//! conversations, an atomic per-row reservation, one queued cloud run per
//! reservation. Unlike the digest worker it never clears its own progress on
//! failure; retries follow a bounded backoff so a persistently failing
//! provider costs at most a handful of calls per day.

use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::cards::{mark_card_seen, sync_card_messages};
use super::config::SystemAgentConfig;
use super::input::Candidate;
use super::limits;
use crate::resource_pools::usage::{settle, Settlement};
use crate::resource_pools::Feature;

pub use super::retry::{fail, release_stale_runs};

/// Stored run ids keep the old prefix.
pub const RUN_PREFIX: &str = "pip_";
const SWEEP_BATCH: i64 = 10;

/// A SQL pattern for an RFC 3339 time as the sweep row stores it.
macro_rules! iso_time {
    () => {
        "'^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}'"
    };
}

/// Conversations worth a run. Every condition reads the same card as the run
/// input (the newest one still in play), so a selected conversation always
/// yields a hook or moves its cursor, and is never reselected every tick.
pub(super) const SWEEP_SQL: &str = concat!(
    "UPDATE cloud_pip_conversation_state state SET checked_at = now()
 WHERE state.conversation_id IN (
     SELECT s.conversation_id
     FROM cloud_pip_conversation_state s
     JOIN cloud_chat_conversations c ON c.conversation_id = s.conversation_id
     JOIN cloud_chat_conversation_members member
       ON member.conversation_id = c.conversation_id
      AND member.account_id = $1 AND member.membership_state = 'active'
     LEFT JOIN LATERAL (
         SELECT card.event_id, card.revision, card.start_at, card.updated_at
         FROM cloud_plan_cards card
         WHERE card.conversation_id = c.conversation_id AND ",
    crate::plan_cards::live_plan_card_sql!(),
    "
         ORDER BY card.updated_at DESC LIMIT 1
     ) card ON true
     WHERE s.active_run_id IS NULL
       AND s.retry_after <= now()
       AND (
         -- Members' new messages (never the System agent's own), once the chat has been
         -- quiet for 30 seconds, or two minutes after the first one, or right away when
         -- one of them asks the System agent directly (`requests::note_direct_request`).
         (c.latest_message_sequence > s.seen_sequence
          AND EXISTS (SELECT 1 FROM cloud_chat_messages msg
            WHERE msg.conversation_id = c.conversation_id
              AND msg.conversation_sequence > s.seen_sequence AND msg.sender_account_id <> $1)
          AND (
            (SELECT msg.created_at FROM cloud_chat_messages msg
              WHERE msg.conversation_id = c.conversation_id AND msg.sender_account_id <> $1
              ORDER BY msg.conversation_sequence DESC LIMIT 1)
              <= now() - interval '30 seconds'
            OR (SELECT msg.created_at FROM cloud_chat_messages msg
              WHERE msg.conversation_id = c.conversation_id
                AND msg.conversation_sequence > s.seen_sequence AND msg.sender_account_id <> $1
              ORDER BY msg.conversation_sequence ASC LIMIT 1)
              <= now() - interval '2 minutes'
            OR CASE WHEN jsonb_typeof(s.hooks_fired->'requestSequence') = 'number'
                 THEN (s.hooks_fired->>'requestSequence')::bigint > s.seen_sequence
                 ELSE false END
          ))
         -- Votes or answers changed the card, and it has been quiet for 45 seconds.
         OR (card.revision > CASE
               WHEN jsonb_typeof(s.hooks_fired->('card_seen:' || card.event_id)) = 'number'
               THEN (s.hooks_fired->>('card_seen:' || card.event_id))::bigint ELSE 0 END
             AND card.updated_at <= now() - interval '45 seconds')
         -- A person's agent owns a task here and it is time to check whether it stalled.
         -- Stored times are cast only when they look like one, so one bad row
         -- never fails the sweep for every conversation.
         OR CASE WHEN s.hooks_fired #>> '{deferred,checkAfter}' ~ ",
    iso_time!(),
    "
              THEN (s.hooks_fired #>> '{deferred,checkAfter}')::timestamptz <= now()
              ELSE false END
         -- A held plan discussion may have gone quiet, or a loop or conflict waited.
         OR CASE WHEN s.hooks_fired #>> '{planDiscussion,checkAfter}' ~ ",
    iso_time!(),
    "
              THEN (s.hooks_fired #>> '{planDiscussion,checkAfter}')::timestamptz <= now()
              ELSE false END
         OR CASE WHEN s.hooks_fired ->> 'triggerCheckAfter' ~ ",
    iso_time!(),
    "
              THEN (s.hooks_fired ->> 'triggerCheckAfter')::timestamptz <= now()
              ELSE false END
         -- A live card changed since the last conflict check, 45 seconds ago or more.
         OR EXISTS (SELECT 1 FROM cloud_plan_cards card
              WHERE card.conversation_id = c.conversation_id
                AND card.updated_at <= now() - interval '45 seconds'
                AND card.updated_at > CASE WHEN s.hooks_fired ->> 'cardsCheckedAt' ~ ",
    iso_time!(),
    "
                  THEN (s.hooks_fired ->> 'cardsCheckedAt')::timestamptz ELSE '-infinity' END
                AND ",
    crate::plan_cards::live_plan_card_sql!(),
    ")
         -- A reminder is due: one window at a time, as the run input offers it.
         OR (card.start_at > now() AND (
               (card.start_at <= now() + interval '2 hours'
                AND NOT (s.hooks_fired ? ('t_minus_2h:' || card.event_id)))
               OR (card.start_at > now() + interval '2 hours'
                AND card.start_at <= now() + interval '24 hours'
                AND NOT (s.hooks_fired ? ('t_minus_24h:' || card.event_id)))))
       )
     ORDER BY s.checked_at ASC
     LIMIT $2)
 RETURNING state.conversation_id,
           (SELECT legacy_session_id FROM cloud_chat_conversations
             WHERE conversation_id = state.conversation_id),
            (SELECT latest_message_sequence FROM cloud_chat_conversations
              WHERE conversation_id = state.conversation_id),
            state.seen_sequence,
            state.context_start_sequence,
            state.hooks_fired"
);

#[derive(Debug, Deserialize)]
pub struct RunOutput {
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default, rename = "hooksHandled")]
    pub hooks_handled: Vec<String>,
}

/// Parses the runner's JSON reply. A bare string is tolerated as a message so
/// a model that forgets the envelope still posts rather than failing.
pub fn parse_run_output(text: &str) -> RunOutput {
    let trimmed = text.trim();
    if let Ok(output) = serde_json::from_str::<RunOutput>(trimmed) {
        return output;
    }
    let message =
        (!trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("null")).then(|| trimmed.to_string());
    RunOutput {
        message,
        hooks_handled: Vec::new(),
    }
}

/// One sweep pass. Returns the number of runs queued.
pub async fn sweep(pool: &PgPool, config: &SystemAgentConfig) -> Result<usize, sqlx_core::Error> {
    // A chat the System agent is already in but has no state yet starts at its
    // newest message, like a chat the System agent just joined.
    query(
        "INSERT INTO cloud_pip_conversation_state
             (conversation_id, seen_sequence, context_start_sequence)
         SELECT conversation.conversation_id, conversation.latest_message_sequence,
                conversation.latest_message_sequence
         FROM cloud_chat_conversations conversation
         JOIN cloud_chat_conversation_members member
           ON member.conversation_id = conversation.conversation_id
          AND member.account_id = $1 AND member.membership_state = 'active'
         WHERE conversation.kind = ANY($2)
         ON CONFLICT (conversation_id) DO NOTHING",
    )
    .bind(&config.account_id)
    .bind(super::membership::SYSTEM_AGENT_CONVERSATION_KINDS)
    .execute(pool)
    .await?;

    let candidates: Vec<(Uuid, Option<String>, i64, i64, i64, Value)> = query_as(SWEEP_SQL)
        .bind(&config.account_id)
        .bind(SWEEP_BATCH)
        .fetch_all(pool)
        .await?;

    let mut queued = 0;
    for (
        conversation_id,
        legacy_session_id,
        latest_sequence,
        seen_sequence,
        context_start_sequence,
        hooks_fired,
    ) in candidates
    {
        let Some(legacy_session_id) = legacy_session_id else {
            continue;
        };
        let candidate = Candidate {
            conversation_id,
            legacy_session_id,
            latest_sequence,
            seen_sequence,
            context_start_sequence,
            hooks_fired,
        };
        // One conversation's bad data or failed read must never stop the
        // System agent everywhere else: log it, hold that conversation back
        // briefly, and go on with the rest.
        match enqueue(pool, config, &candidate).await {
            Ok(true) => queued += 1,
            Ok(false) => {}
            Err(error) => {
                eprintln!("[system-agent] Skipped conversation {conversation_id}: {error}");
                if let Err(error) = hold_back(pool, conversation_id).await {
                    eprintln!("[system-agent] Could not hold back {conversation_id}: {error}");
                }
            }
        }
    }
    Ok(queued)
}

/// How long a conversation that could not be evaluated waits for its next try.
const HOLD_BACK_SECONDS: f64 = 60.0;

async fn hold_back(pool: &PgPool, conversation_id: Uuid) -> Result<(), sqlx_core::Error> {
    query(
        "UPDATE cloud_pip_conversation_state
         SET retry_after = now() + ($2 * interval '1 second'), last_error = 'sweep_failed',
             updated_at = now()
         WHERE conversation_id = $1 AND active_run_id IS NULL",
    )
    .bind(conversation_id)
    .bind(HOLD_BACK_SECONDS)
    .execute(pool)
    .await?;
    Ok(())
}

async fn enqueue(
    pool: &PgPool,
    config: &SystemAgentConfig,
    candidate: &Candidate,
) -> Result<bool, sqlx_core::Error> {
    #[cfg(test)]
    tests::fail_if_broken(candidate.conversation_id)?;
    // A person's agent owns its task: its messages stay context until it
    // replies, or come back as new here once it stalls.
    let (prepared, input, gate) = super::ownership_store::prepare(pool, config, candidate).await?;
    // Batch ordinary conversation until it is quiet. The model decides
    // whether it warrants an intervention; another agent's tasks stay context.
    let planned = super::triggers_store::plan(pool, config, prepared, input, gate).await?;
    let Some((candidate, input)) = planned else {
        // Nothing to react to now. Advance the cursor so the row stops
        // looking dirty; a held plan discussion keeps its own place.
        query(
            "UPDATE cloud_pip_conversation_state SET seen_sequence = $2, updated_at = now()
             WHERE conversation_id = $1 AND active_run_id IS NULL",
        )
        .bind(candidate.conversation_id)
        .bind(candidate.latest_sequence)
        .execute(pool)
        .await?;
        return Ok(false);
    };
    let candidate = &candidate;

    let run_id = format!("{RUN_PREFIX}{}", Uuid::new_v4().simple());
    let mut tx = pool.begin().await?;
    let reserved = query(
        "UPDATE cloud_pip_conversation_state
         SET active_run_id = $2, seen_sequence = $3, updated_at = now()
         WHERE conversation_id = $1 AND active_run_id IS NULL",
    )
    .bind(candidate.conversation_id)
    .bind(&run_id)
    .bind(candidate.latest_sequence)
    .execute(&mut *tx)
    .await?;
    if reserved.rows_affected() == 0 {
        return Ok(false);
    }
    // The conversation's resource pool admits the pass, or it stays silent.
    let (resource_pool, organization_id, admits) =
        limits::pool_for(&mut tx, config, candidate).await?;
    let organization_id = organization_id.as_deref();
    // A disabled organization's work never runs; that is not a limit, so
    // nothing is recorded for Settings.
    let admission = if admits {
        Some(limits::admit(&mut tx, &resource_pool, organization_id, &run_id, candidate).await?)
    } else {
        None
    };
    if !admission.is_some_and(|admission| admission.admitted()) {
        tx.rollback().await?;
        let refused = admission.map(|admission| limits::Refused {
            resource_pool: &resource_pool,
            organization_id,
            admission,
        });
        limits::stay_silent(pool, candidate, &input, refused.as_ref()).await?;
        return Ok(false);
    }
    let now = Utc::now().to_rfc3339();
    // The run belongs to the conversation's organization, not the System
    // agent's own.
    query(
        "INSERT INTO cloud_agent_fallback_runs (
             run_id, idempotency_key, request_message_id, session_id, owner_account_id,
             requester_account_id, status, prompt, system_prompt, runtime_route_json,
             created_at, updated_at, run_trigger, connector_audience, organization_id
         ) VALUES ($1, $1, $1, $2, $3, $3, 'queued', $4, $5, $6, $7, $7, 'background', 'shared', $8)",
    )
    .bind(&run_id)
    .bind(&candidate.legacy_session_id)
    .bind(&config.account_id)
    .bind(input.to_string())
    .bind(super::prompt::for_trigger(&config.system_prompt, &input))
    .bind(resource_pool.routing(Feature::SystemAgent))
    .bind(&now)
    .bind(organization_id)
    .execute(&mut *tx)
    .await?;
    // A pool worker pool's run waits for that pool's own worker.
    crate::pool_workers::store::tag_run(&mut tx, &run_id, &resource_pool, Feature::SystemAgent)
        .await?;
    tx.commit().await?;
    // The person who asked sees the Facilitator working on it right away.
    super::reply_slot::show(
        pool,
        &config.account_id,
        &run_id,
        candidate.conversation_id,
        &input,
    )
    .await;
    Ok(true)
}

pub(super) struct ActiveRun {
    pub(super) conversation_id: Uuid,
    pub(super) owner_account_id: String,
    pub(super) session_id: String,
    created_at: String,
    pub(super) input: Value,
}

pub(super) async fn active_run(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
) -> Result<Option<ActiveRun>, sqlx_core::Error> {
    let row: Option<(String, Uuid, String, String, String)> = query_as(
        "SELECT run.prompt, state.conversation_id, run.owner_account_id, run.created_at, run.session_id
         FROM cloud_agent_fallback_runs run
         JOIN cloud_pip_conversation_state state ON state.active_run_id = run.run_id
         WHERE run.run_id = $1 AND run.claimed_by = $2 AND run.status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(
        |(prompt, conversation_id, owner_account_id, created_at, session_id)| ActiveRun {
            conversation_id,
            owner_account_id,
            session_id,
            created_at,
            input: serde_json::from_str(&prompt).unwrap_or(Value::Null),
        },
    ))
}

/// Every reminder a run was offered counts as fired once the run finishes,
/// whether the System agent posted a nudge or chose to stay silent. The sweep
/// keeps picking a chat while a due reminder is unmarked, so waiting for the
/// model to list it in `hooksHandled` would rerun the chat every tick until the
/// plan starts.
pub(super) fn offered_reminders(input: &Value) -> Value {
    let mut hooks = json!({});
    for key in input["hooks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|hook| hook.get("key").and_then(Value::as_str))
        .filter(|key| key.starts_with("t_minus_"))
    {
        hooks[key] = json!(true);
    }
    hooks
}

/// Records a finished run: posts the System agent's message (if any) into the
/// conversation and marks the one-shot reminders it was offered.
pub async fn complete(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    response_text: &str,
) -> Result<(), sqlx_core::Error> {
    let Some(run) = active_run(pool, run_id, runner_id).await? else {
        return Ok(());
    };
    let output = parse_run_output(response_text);
    let workflow_posted = super::workflows::publish(pool, run_id, &run, response_text).await?;
    // A card the run touched gets its card message first (a new vote or
    // calendar card, or an in-place refresh); the System agent's words follow
    // as their own message.
    let touched: Option<(String,)> = query_as(
        "SELECT event_id FROM cloud_plan_cards
         WHERE conversation_id = $1 AND updated_at >= $2::timestamptz
         ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(run.conversation_id)
    .bind(&run.created_at)
    .fetch_optional(pool)
    .await?;
    let card_touched = touched.is_some();
    if let Some((event_id,)) = touched {
        if let Some(row) = crate::plan_cards::store::load(pool, &event_id).await? {
            if let Err(error) = sync_card_messages(pool, &run.owner_account_id, &row).await {
                eprintln!("[system-agent] Could not post the plan card: {error}");
            }
        }
    }
    use crate::document_shares::agents::create::reply;
    let documents = reply::pending_for_run(&mut *pool.acquire().await?, run_id).await?;
    let message = output
        .message
        .as_deref()
        .filter(|_| !workflow_posted)
        .map(str::trim)
        .filter(|text| !text.is_empty());
    let answered = workflow_posted || card_touched;
    let response_message_id = super::reply_slot::publish(
        pool,
        run_id,
        &run,
        message,
        answered,
        card_touched,
        &documents,
    )
    .await?;

    let hooks = super::triggers::finish_marks(&run.input);

    let now = Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    query(
        "UPDATE cloud_agent_fallback_runs
         SET status = 'completed', response_message_id = $3, updated_at = $4, completed_at = $4
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(&response_message_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    settle(&mut tx, run_id, Settlement::Consumed).await?;
    if response_message_id.is_some() {
        reply::mark_attached(&mut tx, &documents).await?;
    }
    // The System agent saw the card as its input showed it; its own tool calls
    // are recorded as they happen, so votes cast during the run still wake the
    // next sweep.
    let card = &run.input["openCard"];
    if let (Some(event_id), Some(revision)) = (card["eventId"].as_str(), card["revision"].as_i64())
    {
        mark_card_seen(&mut *tx, run.conversation_id, event_id, revision).await?;
    }
    query(
        "UPDATE cloud_pip_conversation_state
         SET active_run_id = NULL, attempts = 0, last_error = NULL,
             hooks_fired = hooks_fired || $2::jsonb, updated_at = now()
         WHERE conversation_id = $1 AND active_run_id = $3",
    )
    .bind(run.conversation_id)
    .bind(hooks)
    .bind(run_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

#[cfg(test)]
#[path = "store_tests.rs"]
pub(super) mod tests;
