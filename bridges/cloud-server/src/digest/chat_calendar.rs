//! Saved-calendar reads for chat. Identity and disclosure scope come from the host.
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use std::sync::Arc;

use super::chat_calendar_shared::{self as shared_scope, Disclosure};
use crate::{
    auth::routes::CloudSession,
    cloud_agent_runtime::runs::{RunError, RunResult},
    server::ServerState,
};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CalendarReadInput {
    #[serde(default)]
    pub offset: usize,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    #[serde(default)]
    pub share_in_conversation: bool,
    /// Requested disclosure level; shared scopes default to availability.
    pub disclosure: Option<Disclosure>,
    pub session_id: Option<String>,
    pub request_message_id: Option<String>,
    /// The admitted run's requester; set by the server, never by a client.
    #[serde(skip)]
    pub run_requester: Option<String>,
}

pub(super) async fn route(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<CalendarReadInput>,
) -> Response {
    match read(state.db_pool(), &session.account_id, input).await {
        Err(RunError::ContextUnavailable(_)) => super::routes::error("calendar_unavailable", "Calendar context is unavailable. Try again.", StatusCode::UNPROCESSABLE_ENTITY),
        Ok(value) => Json(value).into_response(),
        Err(RunError::Persistence(_)) => super::routes::error("calendar_unavailable", "The saved calendar could not be loaded. Try again; this does not mean the calendar is empty.", StatusCode::INTERNAL_SERVER_ERROR),
        Err(RunError::NotFound | RunError::AgentUnavailable | RunError::AiConsentRequired | RunError::GroupClosed) => super::routes::error("calendar_unavailable", "Calendar access is unavailable for this request; this does not mean the calendar is empty.", StatusCode::FORBIDDEN),
    }
}

pub(crate) async fn read(
    pool: &PgPool,
    account: &str,
    input: CalendarReadInput,
) -> RunResult<Value> {
    if input.offset > super::sync_routes::CALENDAR_CAPACITY as usize {
        return Err(RunError::NotFound);
    }
    let (request_kind, disclosure) = match (&input.session_id, &input.request_message_id) {
        (None, None) => (None, input.disclosure.unwrap_or(Disclosure::Details)),
        (Some(session), Some(request)) => {
            let request = shared_scope::authorize_request(
                pool,
                account,
                session,
                request,
                input.run_requester.as_deref(),
            )
            .await?;
            let disclosure = shared_scope::shared_disclosure(
                input.disclosure,
                input.share_in_conversation,
                request,
            )?;
            (Some(request), disclosure)
        }
        _ => return Err(RunError::NotFound),
    };
    let start = parse_instant(input.start_at.as_deref())?;
    let end = parse_instant(input.end_at.as_deref())?;
    if matches!((start, end), (Some(start), Some(end)) if start >= end) {
        return Err(RunError::NotFound);
    }
    let events = super::store::calendar(pool, account).await?;
    let events: Vec<_> = events
        .into_iter()
        .filter(|event| in_window(event, start, end))
        .collect();
    let timezone: Option<(String,)> =
        query_as("SELECT timezone FROM cloud_account_digests WHERE account_id=$1")
            .bind(account)
            .fetch_optional(pool)
            .await?;
    let mut result = page(
        &events,
        input.offset,
        request_kind.is_some(),
        disclosure,
        timezone.map(|row| row.0),
    );
    if let (Some(kind), Disclosure::Availability) = (request_kind, disclosure) {
        result["scope"] = json!(kind.scope());
    }
    result["startAt"] = json!(input.start_at);
    result["endAt"] = json!(input.end_at);
    Ok(result)
}

fn parse_instant(value: Option<&str>) -> RunResult<Option<chrono::DateTime<chrono::FixedOffset>>> {
    value
        .map(chrono::DateTime::parse_from_rfc3339)
        .transpose()
        .map_err(|_| RunError::NotFound)
}

fn in_window(
    event: &super::models::CalendarEvent,
    start: Option<chrono::DateTime<chrono::FixedOffset>>,
    end: Option<chrono::DateTime<chrono::FixedOffset>>,
) -> bool {
    let Ok(event_start) = chrono::DateTime::parse_from_rfc3339(&event.start_at) else {
        return false;
    };
    let event_end = event
        .end_at
        .as_deref()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .unwrap_or(event_start);
    if event.all_day {
        let first_day = event_start.date_naive();
        let last_day = if event_end > event_start {
            event_end.date_naive()
        } else {
            first_day.succ_opt().unwrap_or(first_day)
        };
        return start.is_none_or(|start| last_day > start.date_naive())
            && end.is_none_or(|end| {
                first_day < end.date_naive()
                    || (first_day == end.date_naive() && end.time() != chrono::NaiveTime::MIN)
            });
    }
    // Include ongoing events, but exclude one ending exactly at the window start.
    start.is_none_or(|start| event_start >= start || event_end > start)
        && end.is_none_or(|end| event_start < end)
}

fn page(
    events: &[super::models::CalendarEvent],
    offset: usize,
    shared: bool,
    disclosure: Disclosure,
    timezone: Option<String>,
) -> Value {
    let has_more = events.len() > offset.saturating_add(50);
    let selected = events.iter().skip(offset).take(50);
    let mut result = json!({"status":if events.is_empty(){"empty"}else{"ready"},"source":"saved_kordi_calendar",
        "disclosure":disclosure.as_str(),"timezone":timezone,"retrievedAt":chrono::Utc::now().to_rfc3339(),
        "hasMore":has_more,"nextOffset":has_more.then_some(offset+50)});
    if disclosure == Disclosure::Availability {
        result["scope"] = json!(if shared {
            "owner_requested_shared_availability"
        } else {
            "private_owner_availability"
        });
        result["busyWindows"] = json!(shared_scope::availability_windows(selected));
        result["note"] = json!(shared_scope::AVAILABILITY_NOTE);
        return result;
    }
    let summaries: Vec<_> = selected.map(|event| json!({
        "id": event.id, "title": event.title, "startAt": event.start_at, "endAt": event.end_at,
        "allDay": event.all_day, "timezone": event.timezone, "seriesId": event.series_id,
        "revision": event.revision, "status": "saved"
    })).collect();
    result["scope"] = json!(if shared {
        "owner_requested_shared_read"
    } else {
        "private_owner_read"
    });
    result["events"] = json!(summaries);
    result["note"] = json!("Only saved Kordi events are included. Chat arrangements and digest proposals are not saved events. Summarize only the requested dates and details; do not disclose unrelated events.");
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calendar_windows_include_ongoing_and_all_day_events_across_timezones() {
        let mut event: super::super::models::CalendarEvent = serde_json::from_value(json!({"id":"saved","title":"Meeting","startAt":"2026-09-09T10:00:00Z","endAt":"2026-09-09T12:00:00Z"})).unwrap();
        let start = parse_instant(Some("2026-09-09T07:00:00-04:00")).unwrap();
        let end = parse_instant(Some("2026-09-09T09:00:00-04:00")).unwrap();
        assert!(in_window(&event, start, end));
        assert!(!in_window(&event, end, None));
        event.all_day = true;
        event.start_at = "2026-09-09T00:00:00Z".into();
        event.end_at = None;
        assert!(in_window(&event, start, end));
        assert!(!in_window(
            &event,
            None,
            parse_instant(Some("2026-09-09T00:00:00-04:00")).unwrap()
        ));
        assert!(parse_instant(Some("today")).is_err());
    }
    #[test]
    fn saved_events_empty_pages_and_private_fields_are_distinct() {
        let event = serde_json::from_value(json!({"id":"saved","title":"Saved meeting","startAt":"2026-09-09T12:00:00Z","description":"Private extra detail","sourceIds":["private-source"]})).unwrap();
        let response = page(&[event], 0, true, Disclosure::Details, Some("UTC".into()));
        assert_eq!(response["status"], "ready");
        assert_eq!(response["events"][0]["status"], "saved");
        assert!(!response.to_string().contains("Private extra detail"));
        assert!(!response.to_string().contains("private-source"));
        assert_eq!(
            page(&[], 0, false, Disclosure::Details, None)["status"],
            "empty"
        );
        let event = serde_json::from_value(
            json!({"id":"saved","title":"Saved meeting","startAt":"2026-09-09T12:00:00Z"}),
        )
        .unwrap();
        assert_eq!(
            page(&[event], 50, false, Disclosure::Details, None)["status"],
            "ready"
        );
    }
    #[test]
    fn availability_pages_list_busy_windows_without_event_content() {
        let event = serde_json::from_value(json!({"id":"saved-id","title":"Private dinner","startAt":"2026-09-11T18:00:00Z","endAt":"2026-09-11T20:00:00Z","description":"Private notes"})).unwrap();
        let response = page(&[event], 0, true, Disclosure::Availability, None);
        assert_eq!(response["disclosure"], "availability");
        assert_eq!(response["scope"], "owner_requested_shared_availability");
        assert_eq!(
            response["busyWindows"][0]["startAt"],
            "2026-09-11T18:00:00Z"
        );
        assert!(response.get("events").is_none());
        let text = response.to_string();
        assert!(!text.contains("saved-id") && !text.contains("Private"));
    }
}
