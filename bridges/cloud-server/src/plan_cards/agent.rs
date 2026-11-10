//! Plan and vote cards a person's agent opens and keeps current (issue #2446).
//!
//! A run of a person's agent in a direct chat or group, on the owner's Mac or
//! the cloud runner, opens the card for the plan its task is settling and
//! updates it as details settle. It is the same shared card the System agent
//! opens: answers, votes, confirmation, and calendar entries work unchanged.
//!
//! The run's lease and its task's request authorize it: the task's root run
//! must pass the agent-exchange gate (active membership of its owner and
//! requester, agent access, contact permissions), and a run that resumes the
//! task (after another agent or a person answered) acts for that root.
//! Execution subsessions, an agent answering another agent's request, and
//! background feature runs (the System agent among them) cannot use it. The
//! card records the agent, its owner, and the task's root run, so one task
//! opens one card and only the agent that opened a card updates it.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::agent_proposal::{agent_author, merged, proposal, Card, OptionArgument};
use super::models::{PlanCardRow, PlanCardStoreError};
use super::wire::{blank_to_none, error, store_error, Rejection};
use crate::auth::routes::CloudSession;
use crate::cloud_agent_runtime::runs::{exchanges, RunError};
use crate::server::ServerState;

/// Cards one person's agents may open in an hour, across their chats.
const HOURLY_CREATE_LIMIT: i64 = 20;

/// A tool call from the owner's Mac (`claimId`) or the cloud runner
/// (`runnerId`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Input {
    #[serde(default)]
    runner_id: String,
    #[serde(default)]
    claim_id: Option<Uuid>,
    #[serde(default)]
    #[allow(dead_code)]
    tool_call_id: String,
    #[serde(default)]
    action: String,
    #[serde(default)]
    arguments: Value,
}

/// `POST /v1/cloud/agent-runs/desktop/:run_id/plan-card`: the owner's Mac,
/// holding the run's lease.
pub(crate) async fn desktop_route(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run): Path<String>,
    Json(input): Json<Input>,
) -> Response {
    let Some(claim) = input.claim_id else {
        return *forbidden("This desktop cannot act for the requested run.");
    };
    let executor = format!("desktop:{}:{claim}", session.device_id);
    let pool = state.db_pool();
    respond(
        async {
            let run = authorize(pool, &run, Some((&executor, Some(&session.account_id)))).await?;
            execute(pool, &run, &input.action, input.arguments).await
        }
        .await,
    )
}

/// `POST /v1/cloud/agent-runs/:run_id/agent-plan-card`: the cloud runner,
/// holding the run's lease.
pub(crate) async fn runner_route(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run): Path<String>,
    Json(input): Json<Input>,
) -> Response {
    if !crate::cloud_agent_runtime::routes::runner_authorized_for_scheduled_tasks(&headers) {
        return crate::cloud_agent_runtime::runs::runner_unauthorized();
    }
    let pool = state.db_pool();
    respond(
        async {
            let run = authorize(pool, &run, Some((&input.runner_id, None))).await?;
            execute(pool, &run, &input.action, input.arguments).await
        }
        .await,
    )
}

/// The run a card action acts for.
pub(crate) struct AgentRun {
    pub root: String,
    pub owner: String,
    pub agent: String,
    pub conversation: Uuid,
}

/// The tool's arguments. Absent fields keep the card's current value on
/// update; an empty string or list clears it.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CardArguments {
    #[serde(default)]
    pub(super) kind: Option<String>,
    #[serde(default)]
    pub(super) event_id: Option<String>,
    #[serde(default)]
    pub(super) title: Option<String>,
    #[serde(default)]
    pub(super) start_at: Option<String>,
    #[serde(default)]
    pub(super) end_at: Option<String>,
    #[serde(default)]
    pub(super) location: Option<String>,
    #[serde(default)]
    pub(super) open_items: Option<Vec<String>>,
    #[serde(default)]
    pub(super) options: Option<Vec<OptionArgument>>,
}

fn bad_request(code: &str, message: &str) -> Rejection {
    error(code, message, StatusCode::BAD_REQUEST)
}

fn forbidden(message: &str) -> Rejection {
    error("plan_card_forbidden", message, StatusCode::FORBIDDEN)
}

fn unavailable() -> Rejection {
    error(
        "plan_card_unavailable",
        "Could not update the plan card. Try again.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

fn db(error: sqlx_core::Error) -> Rejection {
    store_error(error.into())
}

/// Whether a run may open cards, for its lease to offer the tool.
pub(crate) async fn available(pool: &PgPool, run: &str) -> bool {
    authorize(pool, run, None).await.is_ok()
}

/// Binds a card action to a run of a person's agent in a direct chat or
/// group. `executor` is the lease holder and, for the Mac, the signed-in
/// owner; `None` checks the run itself, as its lease is handed out.
///
/// A run continues its task: a resume run after another agent or a person
/// answered (and any run whose parent is in the same task) acts for the
/// task's root request, which a member of this conversation made of the
/// same owner's agent; the run keeps its owner, requester, agent, and
/// conversation. An execution
/// subsession, and an agent answering another agent's request, never plan.
pub(crate) async fn authorize(
    pool: &PgPool,
    run: &str,
    executor: Option<(&str, Option<&str>)>,
) -> Result<AgentRun, Rejection> {
    let not_allowed = || forbidden("This run cannot open plan cards in this conversation.");
    let root = task_root(pool, run).await.map_err(db)?;
    let feature_run = |id: &str| {
        crate::cloud_agent_runtime::runs::route_fill::FEATURE_RUN_PREFIXES
            .iter()
            .any(|prefix| id.starts_with(prefix))
    };
    if feature_run(run) || feature_run(&root) {
        return Err(not_allowed());
    }
    let (who, account) = executor.map_or((None, None), |(who, account)| (Some(who), account));
    let checked: Option<(bool, bool, bool)> = query_as(
        "SELECT r.subsession_id IS NOT NULL OR root.subsession_id IS NOT NULL
                OR EXISTS(SELECT 1 FROM cloud_agent_exchanges e
                          WHERE e.target_run_id IN (r.run_id, root.run_id)),
                root.owner_account_id = r.owner_account_id
                AND root.requester_account_id = r.requester_account_id
                AND root.execution_agent_id = r.execution_agent_id
                AND root.session_id = r.session_id,
                ($2::text IS NULL OR (r.claimed_by = $2 AND r.status IN ('leased', 'running')
                    AND r.lease_expires_at::timestamptz > now() AND r.cancel_requested_at IS NULL))
                AND ($3::text IS NULL OR r.owner_account_id = $3)
         FROM cloud_agent_fallback_runs r
         JOIN cloud_agent_fallback_runs root ON root.run_id = $4
         WHERE r.run_id = $1",
    )
    .bind(run)
    .bind(who)
    .bind(account)
    .bind(&root)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let Some((child, same_task, leased)) = checked else {
        return Err(not_allowed());
    };
    if child || !same_task || !leased {
        return Err(not_allowed());
    }
    // The task's request: membership, agent access, and contact permissions
    // as the agent-exchange gate checks them, and a source request that was
    // not deleted.
    let task = match exchanges::authorize(pool, &root, None).await {
        Ok(task) => task,
        Err(RunError::NotFound) => return Err(not_allowed()),
        Err(_) => return Err(unavailable()),
    };
    if !matches!(task.kind.as_str(), "direct" | "group")
        || crate::system_account::is_service_account(&task.owner)
        || crate::system_account::is_service_account(&task.requester)
    {
        return Err(not_allowed());
    }
    Ok(AgentRun {
        root,
        owner: task.owner,
        agent: task.agent,
        conversation: task.conversation,
    })
}

/// The root run of `run`'s task: through the exchanges it resumes and, for a
/// run that is not an execution subsession, its parent runs.
async fn task_root(pool: &PgPool, run: &str) -> Result<String, sqlx_core::Error> {
    let (root,): (String,) = query_as(
        "WITH RECURSIVE chain(run_id, depth) AS (
             SELECT $1::text, 0
             UNION ALL
             SELECT COALESCE(
                        (SELECT e.root_run_id FROM cloud_agent_exchanges e
                         WHERE e.resume_run_id = chain.run_id AND e.root_run_id <> chain.run_id
                         ORDER BY e.created_at LIMIT 1),
                        (SELECT r.parent_run_id FROM cloud_agent_fallback_runs r
                         WHERE r.run_id = chain.run_id AND r.subsession_id IS NULL)),
                    chain.depth + 1
             FROM chain WHERE chain.run_id IS NOT NULL AND chain.depth < 16)
         SELECT run_id FROM chain WHERE run_id IS NOT NULL ORDER BY depth DESC LIMIT 1",
    )
    .bind(run)
    .fetch_one(pool)
    .await?;
    Ok(root)
}

/// Runs one tool action for an authorized run.
pub(crate) async fn execute(
    pool: &PgPool,
    run: &AgentRun,
    action: &str,
    arguments: Value,
) -> Result<Value, Rejection> {
    if action == "capabilities" {
        return Ok(json!({"available": true}));
    }
    let arguments: CardArguments = serde_json::from_value(arguments).map_err(|err| {
        bad_request(
            "invalid_plan_card_request",
            &format!("Plan card request is invalid: {err}"),
        )
    })?;
    let row = match action {
        "create" => create(pool, run, arguments).await?,
        "update" => update(pool, run, arguments).await?,
        _ => {
            return Err(bad_request(
                "invalid_plan_card_request",
                "action must be create or update.",
            ))
        }
    };
    if let Err(error) = crate::system_agent::cards::sync_card_messages_as(
        pool,
        &run.owner,
        crate::common_ground::SYSTEM_NOTICE_KIND,
        &row,
    )
    .await
    {
        eprintln!("[plan-card] Could not post the agent's plan card: {error}");
    }
    Ok(json!({
        "eventId": row.event_id,
        "kind": card_kind(&row),
        "card": crate::system_agent::context::compact_card(&row),
    }))
}

fn card_kind(row: &PlanCardRow) -> &'static str {
    match crate::system_agent::cards::card_view(row) {
        "vote" => "vote",
        _ => "plan",
    }
}

/// A desktop or runner response for one action.
pub(crate) fn respond(result: Result<Value, Rejection>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(rejection) => *rejection,
    }
}

async fn create(
    pool: &PgPool,
    run: &AgentRun,
    arguments: CardArguments,
) -> Result<PlanCardRow, Rejection> {
    if blank_to_none(arguments.event_id.clone()).is_some() {
        return Err(bad_request(
            "invalid_plan_card_request",
            "To change an existing card, use action update with its eventId.",
        ));
    }
    let existing: Option<(String,)> = query_as(
        "SELECT event_id FROM cloud_plan_cards
         WHERE created_by_task_run_id = $1 AND conversation_id = $2 AND state <> 'canceled'
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&run.root)
    .bind(run.conversation)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    if let Some((event_id,)) = existing {
        return Err(error(
            "plan_card_exists",
            &format!(
                "This task already opened card {event_id}. Change it with action update and \
                 eventId {event_id}; never open a second card for the same plan."
            ),
            StatusCode::CONFLICT,
        ));
    }
    let (recent,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_plan_cards
         WHERE created_by_account_id = $1 AND created_by_agent_id IS NOT NULL
           AND created_at > now() - interval '1 hour'",
    )
    .bind(&run.owner)
    .fetch_one(pool)
    .await
    .map_err(db)?;
    if recent >= HOURLY_CREATE_LIMIT {
        return Err(error(
            "plan_card_rate_limited",
            "Too many plan cards were opened in the last hour. Try again later.",
            StatusCode::TOO_MANY_REQUESTS,
        ));
    }
    let author = agent_author(pool, run).await.map_err(db)?;
    let title = blank_to_none(arguments.title.clone())
        .ok_or_else(|| bad_request("invalid_title", "title is required."))?;
    let card = Card {
        title,
        start_at: blank_to_none(arguments.start_at.clone()),
        end_at: blank_to_none(arguments.end_at.clone()),
        location: blank_to_none(arguments.location.clone()),
        open_items: arguments.open_items.clone().unwrap_or_default(),
        options: arguments.options.clone().unwrap_or_default(),
    };
    let args = proposal(pool, run, None, arguments.kind.as_deref(), card).await?;
    super::store::propose_for_agent(pool, args, &author, &run.root)
        .await
        .map_err(store_error)
}

async fn update(
    pool: &PgPool,
    run: &AgentRun,
    arguments: CardArguments,
) -> Result<PlanCardRow, Rejection> {
    let event_id = blank_to_none(arguments.event_id.clone()).ok_or_else(|| {
        bad_request(
            "invalid_plan_card_request",
            "eventId is required for update.",
        )
    })?;
    // One retry when a member answered between reading the card and writing it.
    for attempt in 0..2 {
        let current = super::store::load(pool, &event_id)
            .await
            .map_err(db)?
            .filter(|card| card.conversation_id == run.conversation.to_string())
            .ok_or_else(|| store_error(PlanCardStoreError::NotFound))?;
        let Some(author) = current
            .agent
            .clone()
            .filter(|agent| agent.agent_id == run.agent && agent.owner_account_id == run.owner)
        else {
            return Err(forbidden(
                "Only the agent that opened this card can change it.",
            ));
        };
        let card = merged(&current, &arguments);
        let args = proposal(
            pool,
            run,
            Some((&event_id, current.revision)),
            arguments.kind.as_deref(),
            card,
        )
        .await?;
        match super::store::propose_for_agent(pool, args, &author, &run.root).await {
            Err(PlanCardStoreError::RevisionConflict) if attempt == 0 => continue,
            result => return result.map_err(store_error),
        }
    }
    Err(store_error(PlanCardStoreError::RevisionConflict))
}

/// A live card a person's agent opened in this conversation in the last day
/// for an overlapping time (or with no time yet): the System agent keeps its
/// answers but opens no second card for the same plan. Returns the card and
/// the agent's name.
pub(super) async fn agent_card_for_same_plan(
    pool: &PgPool,
    conversation_id: Uuid,
    start_at: Option<&str>,
    end_at: Option<&str>,
) -> Result<Option<(String, String)>, sqlx_core::Error> {
    let found: Option<(String,)> = query_as(concat!(
        "SELECT card.event_id FROM cloud_plan_cards card
         WHERE card.conversation_id = $1 AND card.created_by_agent_id IS NOT NULL
           AND card.created_at > now() - interval '1 day' AND ",
        crate::plan_cards::live_plan_card_sql!(),
        " AND ($2::timestamptz IS NULL OR card.start_at IS NULL OR (
                card.start_at < COALESCE($3::timestamptz, $2::timestamptz + interval '2 hours')
                AND $2::timestamptz < COALESCE(card.end_at, card.start_at + interval '2 hours')))
         ORDER BY card.created_at DESC LIMIT 1"
    ))
    .bind(conversation_id)
    .bind(start_at)
    .bind(end_at)
    .fetch_optional(pool)
    .await?;
    match found {
        Some((event_id,)) => opened_by_agent(pool, &event_id).await,
        None => Ok(None),
    }
}

/// The card and the name of the person's agent that opened it, when one did.
pub(super) async fn opened_by_agent(
    pool: &PgPool,
    event_id: &str,
) -> Result<Option<(String, String)>, sqlx_core::Error> {
    let card = super::store::load(pool, event_id).await?;
    Ok(card.and_then(|card| {
        let label = card.agent.as_ref()?.label();
        Some((card.event_id, label))
    }))
}
