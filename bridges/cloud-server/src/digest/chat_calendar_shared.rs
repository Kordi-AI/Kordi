//! Shared-conversation calendar scope: who asked, and how much may be disclosed.
//!
//! In a shared conversation the owner's own request unlocks availability only
//! (busy windows without event content). Event details additionally need the
//! owner's explicit `shareInConversation` request on a direct human message.
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::cloud_agent_runtime::runs::{exchanges::PREFIX, RunError, RunResult};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Disclosure {
    /// Busy windows only: start, end, all-day flag and timezone.
    Availability,
    /// Saved event summaries, including titles.
    Details,
}

impl Disclosure {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Availability => "availability",
            Self::Details => "details",
        }
    }
}

/// How the shared request was authorized.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SharedRequest {
    /// The owner's own visible human message in this conversation.
    Direct,
    /// The continuation of the owner's request after another agent replied.
    Continuation,
}

/// Effective disclosure for a shared conversation. Details need the explicit
/// owner opt-in on a direct request; everything else is availability only.
pub(super) fn shared_disclosure(
    requested: Option<Disclosure>,
    share_in_conversation: bool,
    request: SharedRequest,
) -> RunResult<Disclosure> {
    let details_allowed = share_in_conversation && request == SharedRequest::Direct;
    match requested {
        Some(Disclosure::Details) if !details_allowed => Err(RunError::NotFound),
        Some(level) => Ok(level),
        None if details_allowed => Ok(Disclosure::Details),
        None => Ok(Disclosure::Availability),
    }
}

/// Revalidate that `request` is the account owner's own human request in
/// `session`, on every read. Agent-exchange continuations resolve to the
/// original human request; any other agent-exchange id (including requests
/// another agent sent to this owner's agent) is rejected.
pub(super) async fn authorize_request(
    pool: &PgPool,
    account: &str,
    session: &str,
    request: &str,
) -> RunResult<SharedRequest> {
    let (human_request, kind) = match request.strip_prefix(PREFIX) {
        None => (request.to_owned(), SharedRequest::Direct),
        Some(rest) => (
            continuation_root_request(pool, account, session, request, rest).await?,
            SharedRequest::Continuation,
        ),
    };
    // Resolve transport aliases, then revalidate the canonical human sender,
    // active membership, message visibility and deletion.
    let (_, wire) =
        crate::cloud_agent_runtime::runs::request_identity(pool, session, &human_request)
            .await?
            .ok_or(RunError::NotFound)?;
    let sources = super::store::sources(pool, account, Some(std::slice::from_ref(&wire))).await?;
    if !sources.iter().any(|source| {
        source.id == wire
            && source.session_id == session
            && source.sender_account_id == account
            && !source.is_agent
    }) {
        return Err(RunError::NotFound);
    }
    Ok(kind)
}

async fn continuation_root_request(
    pool: &PgPool,
    account: &str,
    session: &str,
    request: &str,
    rest: &str,
) -> RunResult<String> {
    let exchange = rest
        .strip_suffix(":resume")
        .and_then(|id| uuid::Uuid::parse_str(id).ok())
        .ok_or(RunError::NotFound)?;
    // Both the continuation and the original run belong to the owner and were
    // requested by the owner; the original run carries the human request.
    let row: Option<(String,)> = query_as(
        "SELECT root.request_message_id FROM cloud_agent_exchanges e
         JOIN cloud_agent_fallback_runs resume ON resume.run_id=e.resume_run_id
         JOIN cloud_agent_fallback_runs root ON root.run_id=e.root_run_id
         WHERE e.exchange_id=$1 AND resume.request_message_id=$2
           AND resume.session_id=$3 AND root.session_id=$3
           AND resume.owner_account_id=$4 AND resume.requester_account_id=$4
           AND root.owner_account_id=$4 AND root.requester_account_id=$4
           AND resume.subsession_id IS NULL AND root.subsession_id IS NULL",
    )
    .bind(exchange)
    .bind(request)
    .bind(session)
    .bind(account)
    .fetch_optional(pool)
    .await?;
    let (root_request,) = row.ok_or(RunError::NotFound)?;
    if root_request.starts_with(PREFIX) {
        return Err(RunError::NotFound);
    }
    Ok(root_request)
}

/// Busy windows only. Titles, descriptions, links, sources, ids, series and
/// revisions never leave the server at this disclosure level.
pub(super) fn availability_windows<'a>(
    events: impl Iterator<Item = &'a super::models::CalendarEvent>,
) -> Vec<Value> {
    events
        .map(|event| {
            json!({
                "startAt": event.start_at, "endAt": event.end_at, "allDay": event.all_day,
                "timezone": event.timezone, "busy": true
            })
        })
        .collect()
}

pub(super) const AVAILABILITY_NOTE: &str = "Availability only: busy windows from the owner's saved Kordi calendar. Event titles and details are withheld in this shared conversation. Share only the free or busy times relevant to the request. Within the requested range, time not covered by a window is free in the saved calendar; say nothing about times outside it. Event details need the owner's explicit request to share them here.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn details_need_an_explicit_owner_opt_in_on_a_direct_request() {
        use Disclosure::*;
        use SharedRequest::*;
        assert_eq!(
            shared_disclosure(None, false, Direct).unwrap(),
            Availability
        );
        assert_eq!(shared_disclosure(None, true, Direct).unwrap(), Details);
        assert_eq!(
            shared_disclosure(Some(Availability), true, Direct).unwrap(),
            Availability
        );
        assert!(shared_disclosure(Some(Details), false, Direct).is_err());
        assert_eq!(
            shared_disclosure(None, true, Continuation).unwrap(),
            Availability
        );
        assert!(shared_disclosure(Some(Details), true, Continuation).is_err());
    }

    #[test]
    fn availability_windows_carry_no_event_content() {
        let event: super::super::models::CalendarEvent = serde_json::from_value(json!({
            "id":"private-id","title":"Private title","startAt":"2026-09-11T18:00:00Z",
            "endAt":"2026-09-11T20:00:00Z","description":"Private notes","links":["https://example.test/x"],
            "sourceIds":["private-source"],"seriesId":"private-series","externalUid":"private-uid",
            "timezone":"UTC","revision":7
        }))
        .unwrap();
        let windows = availability_windows(std::iter::once(&event));
        let text = serde_json::to_string(&windows).unwrap();
        for private in [
            "private-id",
            "Private title",
            "Private notes",
            "example.test",
            "private-source",
            "private-series",
            "private-uid",
            "revision",
        ] {
            assert!(!text.contains(private), "{private} leaked");
        }
        assert_eq!(windows[0]["startAt"], "2026-09-11T18:00:00Z");
        assert_eq!(windows[0]["endAt"], "2026-09-11T20:00:00Z");
        assert_eq!(windows[0]["busy"], true);
    }
}
