use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::{task_proposal_id, Card};
use crate::{
    auth::routes::{cloud_session_middleware, CloudSession},
    memory_store::{self, SaveMemoryRequest},
    proactive::{
        self,
        decision::{Choice, DecisionError},
    },
    server::ServerState,
};

pub(crate) fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/cloud/facilitator/cards/:id", get(read).post(act))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state)
}

#[derive(Debug)]
struct ActionError(StatusCode, String);
type Result<T> = std::result::Result<T, ActionError>;

impl IntoResponse for ActionError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(json!({"errorCode": "facilitator_card_action_failed", "message": self.1})),
        )
            .into_response()
    }
}

impl From<sqlx_core::Error> for ActionError {
    fn from(_: sqlx_core::Error) -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not update the Facilitator card.".into(),
        )
    }
}

fn denied() -> ActionError {
    ActionError(StatusCode::NOT_FOUND, "Card is unavailable.".into())
}

fn changed() -> ActionError {
    ActionError(
        StatusCode::CONFLICT,
        "The card changed. Review it and try again.".into(),
    )
}

async fn member_card(pool: &PgPool, account: &str, id: Uuid) -> Result<(Card, String)> {
    let card = Card::load(pool, id).await?.ok_or_else(denied)?;
    let role: Option<(String,)> = query_as(
        "SELECT role FROM cloud_chat_conversation_members WHERE conversation_id = $1 AND account_id = $2
           AND membership_state = 'active'",
    ).bind(card.conversation).bind(account).fetch_optional(pool).await?;
    let Some((role,)) = role else {
        return Err(denied());
    };
    Ok((card, role))
}

async fn read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse> {
    let pool = state.db_pool();
    let account = &session.account_id;
    let (card, _) = member_card(pool, account, id).await?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(card.snapshot_for(pool, account).await?),
    ))
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Action {
    Vote { revision: i64, option: usize },
    Confirm { revision: i64, option: usize },
    SaveMemory { revision: i64 },
    Approve,
    Decline,
}

async fn act(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(id): Path<Uuid>,
    Json(action): Json<Action>,
) -> Result<Json<Value>> {
    let pool = state.db_pool();
    let account = &session.account_id;
    let (card, role) = member_card(pool, account, id).await?;
    let (revision, votes, result) = match action {
        Action::Vote { revision, option } if card.kind == "decision" => {
            if option >= card.counts().len() {
                return Err(changed());
            }
            let mut votes = card.votes;
            votes[account] = json!(option);
            (revision, votes, None)
        }
        Action::Confirm { revision, option }
            if card.kind == "decision" && matches!(role.as_str(), "owner" | "admin") =>
        {
            let counts = card.counts();
            let Some(count) = counts.get(option).copied() else {
                return Err(changed());
            };
            if count == 0
                || counts
                    .iter()
                    .enumerate()
                    .any(|(index, other)| index != option && *other >= count)
            {
                return Err(ActionError(
                    StatusCode::CONFLICT,
                    "Wait for a clear vote result before confirming.".into(),
                ));
            }
            (revision, card.votes, Some(option.to_string()))
        }
        Action::SaveMemory { revision } if card.kind == "memory" => {
            if card.result.is_some() {
                return Ok(Json(card.snapshot_for(pool, account).await?));
            }
            if revision != card.revision {
                return Err(changed());
            }
            let memory = memory_store::save(
                pool,
                account,
                &SaveMemoryRequest {
                    scope: "group".into(),
                    scope_id: card.conversation.to_string(),
                    scope_label: None,
                    source: "manual".into(),
                    text: card.content["detail"].as_str().unwrap_or_default().into(),
                    client_memory_id: Some(format!("facilitator-{id}")),
                    category: None,
                    categories: None,
                    confidence: None,
                    declared_by: Some("user".into()),
                },
            )
            .await
            .map_err(|error| ActionError(error.status, error.message))?;
            let memory = match memory {
                memory_store::SaveOutcome::Created(memory)
                | memory_store::SaveOutcome::Existing(memory) => memory,
            };
            (revision, card.votes, Some(memory.memory_id))
        }
        action @ (Action::Approve | Action::Decline)
            if card.kind == "task" && card.content["assigneeId"] == account.as_str() =>
        {
            let choice = if matches!(action, Action::Approve) {
                Choice::Allow
            } else {
                Choice::Decline
            };
            match proactive::decision::decide(
                pool,
                account,
                &proactive::agents::default_agent_id(account),
                &task_proposal_id(id),
                choice,
            )
            .await
            {
                Ok(_) => {
                    query("UPDATE cloud_facilitator_cards SET revision = revision + 1 WHERE card_id = $1")
                        .bind(id).execute(pool).await?;
                    let card = Card::load(pool, id).await?.ok_or_else(denied)?;
                    card.sync(pool).await?;
                    return Ok(Json(card.snapshot_for(pool, account).await?));
                }
                Err(DecisionError::Conflict) => return Err(changed()),
                Err(DecisionError::Database(error)) => return Err(error.into()),
                Err(_) => return Err(denied()),
            }
        }
        _ => return Err(denied()),
    };
    if revision != card.revision {
        return Err(changed());
    }
    let updated = query(
        "UPDATE cloud_facilitator_cards SET votes = $3, result = $4, revision = revision + 1
        WHERE card_id = $1 AND revision = $2 AND result IS NULL",
    )
    .bind(id)
    .bind(revision)
    .bind(votes)
    .bind(result)
    .execute(pool)
    .await?;
    let card = Card::load(pool, id).await?.ok_or_else(denied)?;
    if updated.rows_affected() == 0 && !(card.kind == "memory" && card.result.is_some()) {
        return Err(changed());
    }
    card.sync(pool).await?;
    Ok(Json(card.snapshot_for(pool, account).await?))
}

#[cfg(test)]
mod tests;
