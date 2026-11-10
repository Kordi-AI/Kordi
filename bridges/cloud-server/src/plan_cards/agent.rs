//! Plan and vote cards a person's agent opens and keeps current (issue #2446).
//!
//! A run of a person's agent in a direct chat or group, on the owner's Mac or
//! the cloud runner, opens the card for the plan its task is settling and
//! updates it as details settle. It is the same shared card the System agent
//! opens: answers, votes, confirmation, and calendar entries work unchanged.
//!
//! The run's lease and the active membership of its owner and requester in
//! the run's conversation authorize it (the agent-exchange gate). Execution
//! subsessions, child runs, an agent answering another agent's request, and
//! background feature runs (the System agent among them) cannot use it. The
//! card records the agent, its owner, and the task, so one task opens one
//! card and only the agent that opened a card updates it.

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
pub(crate) async fn authorize(
    pool: &PgPool,
    run: &str,
    executor: Option<(&str, Option<&str>)>,
) -> Result<AgentRun, Rejection> {
    let not_allowed = || forbidden("This run cannot open plan cards in this conversation.");
    if crate::cloud_agent_runtime::runs::route_fill::FEATURE_RUN_PREFIXES
        .iter()
        .any(|prefix| run.starts_with(prefix))
    {
        return Err(not_allowed());
    }
    let parent = match exchanges::authorize(pool, run, executor).await {
        Ok(parent) => parent,
        Err(RunError::NotFound) => return Err(not_allowed()),
        Err(_) => return Err(unavailable()),
    };
    if !matches!(parent.kind.as_str(), "direct" | "group")
        || crate::system_account::is_service_account(&parent.owner)
        || crate::system_account::is_service_account(&parent.requester)
    {
        return Err(not_allowed());
    }
    // Not an execution subsession or child run, and not another agent
    // answering this agent's request: the agent that owns the task plans.
    let (child,): (bool,) = query_as(
        "SELECT r.parent_run_id IS NOT NULL OR r.subsession_id IS NOT NULL
                OR EXISTS(SELECT 1 FROM cloud_agent_exchanges e WHERE e.target_run_id = r.run_id)
         FROM cloud_agent_fallback_runs r WHERE r.run_id = $1",
    )
    .bind(run)
    .fetch_one(pool)
    .await
    .map_err(db)?;
    if child {
        return Err(not_allowed());
    }
    Ok(AgentRun {
        root: parent.root,
        owner: parent.owner,
        agent: parent.agent,
        conversation: parent.conversation,
    })
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
/// answers but opens no second card for the same plan.
pub(super) async fn agent_card_for_same_plan(
    pool: &PgPool,
    conversation_id: Uuid,
    start_at: Option<&str>,
    end_at: Option<&str>,
) -> Result<Option<(String, String)>, sqlx_core::Error> {
    query_as(concat!(
        "SELECT card.event_id, COALESCE(card.created_by_agent_name, 'A person''s agent')
         FROM cloud_plan_cards card
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
    .await
}

/// Whether a person's agent opened this card.
pub(super) async fn opened_by_agent(
    pool: &PgPool,
    event_id: &str,
) -> Result<Option<String>, sqlx_core::Error> {
    let row: Option<(Option<String>,)> = query_as(
        "SELECT created_by_agent_name FROM cloud_plan_cards
         WHERE event_id = $1 AND created_by_agent_id IS NOT NULL",
    )
    .bind(event_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(name,)| name.unwrap_or_else(|| "A person's agent".to_string())))
}
