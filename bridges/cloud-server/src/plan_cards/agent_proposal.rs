//! The card a person's agent proposes: its arguments merged with the current
//! card on update, validated through the proposal checks every card passes.

use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::agent::{AgentRun, CardArguments};
use super::models::{PlanCardAgent, PlanCardProposeArgs, PlanCardRow};
use super::wire::{blank_to_none, error, store_error, ProposeRequest, Rejection};

const MIN_OPTIONS: usize = 2;
const MAX_OPTIONS: usize = 4;

fn bad_request(code: &str, message: &str) -> Rejection {
    error(code, message, StatusCode::BAD_REQUEST)
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OptionArgument {
    #[serde(default)]
    id: Option<String>,
    label: String,
    #[serde(default)]
    start_at: Option<String>,
    #[serde(default)]
    end_at: Option<String>,
    #[serde(default)]
    location: Option<String>,
}

/// The card's content before validation.
pub(super) struct Card {
    pub title: String,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    pub location: Option<String>,
    pub open_items: Vec<String>,
    pub options: Vec<OptionArgument>,
}

/// An absent field keeps the current value; an empty one clears it.
fn kept(update: &Option<String>, current: &Option<String>) -> Option<String> {
    match update {
        None => current.clone(),
        Some(value) => blank_to_none(Some(value.clone())),
    }
}

pub(super) fn merged(current: &PlanCardRow, arguments: &CardArguments) -> Card {
    let start_at = kept(&arguments.start_at, &current.start_at);
    let mut end_at = kept(&arguments.end_at, &current.end_at);
    // A new start after the old end leaves the end unknown, not invalid.
    if arguments.end_at.is_none() {
        let parse = |value: &Option<String>| {
            value
                .as_deref()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        };
        if let (Some(start), Some(end)) = (parse(&start_at), parse(&end_at)) {
            if end < start {
                end_at = None;
            }
        }
    }
    Card {
        title: blank_to_none(arguments.title.clone()).unwrap_or_else(|| current.title.clone()),
        start_at,
        end_at,
        location: kept(&arguments.location, &current.location),
        open_items: arguments
            .open_items
            .clone()
            .unwrap_or_else(|| current.unresolved_fields.clone()),
        options: arguments.options.clone().unwrap_or_else(|| {
            current
                .options
                .iter()
                .map(|option| OptionArgument {
                    id: Some(option.id.clone()),
                    label: option.label.clone(),
                    start_at: option.start_at.clone(),
                    end_at: option.end_at.clone(),
                    location: option.location.clone(),
                })
                .collect()
        }),
    }
}

/// Validates the card through the same proposal checks the System agent's
/// cards pass, with every active member of the conversation on it and the
/// agent's owner as its organizer.
pub(super) async fn proposal(
    pool: &PgPool,
    run: &AgentRun,
    existing: Option<(&str, i64)>,
    kind: Option<&str>,
    mut card: Card,
) -> Result<PlanCardProposeArgs, Rejection> {
    let vote = match kind.map(str::trim).filter(|kind| !kind.is_empty()) {
        Some("vote") => true,
        Some("plan") => false,
        None => !card.options.is_empty(),
        Some(_) => return Err(bad_request("invalid_kind", "kind must be plan or vote.")),
    };
    if vote && !(MIN_OPTIONS..=MAX_OPTIONS).contains(&card.options.len()) {
        return Err(bad_request(
            "invalid_options",
            "A vote card needs 2 to 4 options.",
        ));
    }
    if !vote {
        card.options.clear();
    }
    let state = if vote || card.start_at.is_none() {
        "polling"
    } else {
        "awaitingConfirmation"
    };
    if !vote && card.start_at.is_none() && !card.open_items.iter().any(|item| item == "time") {
        card.open_items.push("time".to_string());
    }
    let members: Vec<(String, String)> = query_as(
        "SELECT member.account_id, COALESCE(NULLIF(trim(account.display_name), ''), 'Member')
         FROM cloud_chat_conversation_members member
         JOIN cloud_accounts account ON account.account_id = member.account_id
         WHERE member.conversation_id = $1 AND member.membership_state = 'active'
         ORDER BY member.account_id",
    )
    .bind(run.conversation)
    .fetch_all(pool)
    .await
    .map_err(|err| store_error(err.into()))?;
    let participants: Vec<Value> = members
        .into_iter()
        .filter(|(account_id, _)| !crate::system_account::is_service_account(account_id))
        .map(|(account_id, display_name)| {
            json!({
                "participantId": account_id,
                "displayName": display_name,
                "organizer": account_id == run.owner,
            })
        })
        .collect();
    let options: Vec<Value> = card
        .options
        .iter()
        .map(|option| {
            json!({
                "id": option.id,
                "label": option.label,
                "startAt": option.start_at,
                "endAt": option.end_at,
                "location": option.location,
            })
        })
        .collect();
    let request: ProposeRequest = serde_json::from_value(json!({
        "conversationId": run.conversation.to_string(),
        "existingEventId": existing.map(|(event_id, _)| event_id),
        "existingRevision": existing.map(|(_, revision)| revision),
        "title": card.title,
        "startAt": card.start_at,
        "endAt": card.end_at,
        "location": card.location,
        "state": state,
        "unresolvedFields": card.open_items,
        "participants": participants,
        "options": options,
    }))
    .map_err(|err| {
        bad_request(
            "invalid_plan_card_request",
            &format!("Plan card request is invalid: {err}"),
        )
    })?;
    request.into_args(Some(run.conversation))
}

/// "<owner>'s <agent>", as the card and calendar entries name the agent.
pub(super) async fn agent_author(
    pool: &PgPool,
    run: &AgentRun,
) -> Result<PlanCardAgent, sqlx_core::Error> {
    let (owner_name, agent_name): (String, String) = query_as(
        "SELECT COALESCE(NULLIF(trim(account.display_name), ''), 'Someone'),
                COALESCE(
                    (SELECT NULLIF(trim(definition.name), '') FROM cloud_agent_definitions definition
                     WHERE definition.agent_id = $2 AND definition.owner_account_id = $1),
                    (SELECT NULLIF(trim(profile.display_name), '') FROM cloud_default_agent_profiles profile
                     WHERE profile.owner_account_id = $1),
                    'Kordi')
         FROM cloud_accounts account WHERE account.account_id = $1",
    )
    .bind(&run.owner)
    .bind(&run.agent)
    .fetch_one(pool)
    .await?;
    Ok(PlanCardAgent {
        agent_id: run.agent.clone(),
        owner_account_id: run.owner.clone(),
        name: format!("{owner_name}'s {agent_name}"),
    })
}
