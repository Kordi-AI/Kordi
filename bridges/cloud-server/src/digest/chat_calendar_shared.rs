//! Shared-conversation calendar scope: who asked, and how much may be disclosed.
//!
//! In a shared conversation the owner's own request unlocks availability only
//! (busy windows without event content). Event details additionally need the
//! owner's explicit `shareInConversation` request on a direct human message.
//! Another member, or another member's agent, may ask the owner's own agent
//! for availability while the owner shares busy/free with people in their
//! chats; nobody else ever reads the owner's calendar directly.
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
    /// The owner's request carried on by the owner's agents (after another
    /// agent replied, or one of the owner's agents asking another).
    Continuation,
    /// Another active member asked the owner's agent, directly or through
    /// their own agent, and the owner shares busy/free with their chats.
    Member,
}

impl SharedRequest {
    pub(super) fn scope(self) -> &'static str {
        match self {
            Self::Member => "member_requested_shared_availability",
            _ => "owner_requested_shared_availability",
        }
    }
}

/// Effective disclosure for a shared conversation. Details need the explicit
/// owner opt-in on a direct request; everything else is availability only.
pub(super) fn shared_disclosure(
    requested: Option<Disclosure>,
    share_in_conversation: bool,
    request: SharedRequest,
) -> RunResult<Disclosure> {
    // Another member never asks for details, not even to have them downgraded.
    if share_in_conversation && request == SharedRequest::Member {
        return Err(RunError::NotFound);
    }
    let details_allowed = share_in_conversation && request == SharedRequest::Direct;
    match requested {
        Some(Disclosure::Details) if !details_allowed => Err(RunError::NotFound),
        Some(level) => Ok(level),
        None if details_allowed => Ok(Disclosure::Details),
        None => Ok(Disclosure::Availability),
    }
}

/// Who a shared request came from, resolved from server records only.
struct Origin {
    /// The visible human message the request started from.
    human_request: String,
    /// Its required sender; `None` accepts any human member.
    requester: Option<String>,
    /// Owner of the agent that asked, when another agent asked.
    asking_owner: Option<String>,
}

/// Revalidate a shared request on every read. A plain id is a visible human
/// message. `agent-exchange:<id>:resume` is the owner's agent continuing after
/// another agent replied; `agent-exchange:<id>:request` is another agent asking
/// the owner's agent. Both resolve to the original human request.
pub(super) async fn authorize_request(
    pool: &PgPool,
    account: &str,
    session: &str,
    request: &str,
    run_requester: Option<&str>,
) -> RunResult<SharedRequest> {
    if crate::system_account::is_service_account(account) {
        return Err(RunError::NotFound);
    }
    let origin = match request.strip_prefix(PREFIX) {
        None => Origin {
            human_request: request.to_owned(),
            requester: None,
            asking_owner: None,
        },
        Some(rest) => exchange_origin(pool, account, session, request, rest).await?,
    };
    // Resolve transport aliases, then revalidate the canonical human sender,
    // the owner's active membership, message visibility, blocks and deletion.
    let (_, wire) =
        crate::cloud_agent_runtime::runs::request_identity(pool, session, &origin.human_request)
            .await?
            .ok_or(RunError::NotFound)?;
    let sources = super::store::sources(pool, account, Some(std::slice::from_ref(&wire))).await?;
    let sender = sources
        .iter()
        .find(|source| {
            source.id == wire
                && source.session_id == session
                && !source.is_agent
                && origin
                    .requester
                    .as_deref()
                    .is_none_or(|requester| source.sender_account_id == requester)
        })
        .map(|source| source.sender_account_id.clone())
        .ok_or(RunError::NotFound)?;
    // A run started by one member never borrows another member's request.
    if run_requester.is_some_and(|requester| requester != sender) {
        return Err(RunError::NotFound);
    }
    if sender == account {
        return Ok(if request.starts_with(PREFIX) {
            SharedRequest::Continuation
        } else {
            SharedRequest::Direct
        });
    }
    let mut members = vec![account.to_owned(), sender];
    members.extend(origin.asking_owner);
    if members
        .iter()
        .any(|member| crate::system_account::is_service_account(member))
        || !shares_availability(pool, account).await?
        || !active_members(pool, session, &members).await?
    {
        return Err(RunError::NotFound);
    }
    Ok(SharedRequest::Member)
}

async fn exchange_origin(
    pool: &PgPool,
    account: &str,
    session: &str,
    request: &str,
    rest: &str,
) -> RunResult<Origin> {
    let (id, resume) = match rest.rsplit_once(':') {
        Some((id, "resume")) => (id, true),
        Some((id, "request")) => (id, false),
        _ => return Err(RunError::NotFound),
    };
    let exchange = uuid::Uuid::parse_str(id).map_err(|_| RunError::NotFound)?;
    // The run reading the calendar is this owner's agent: the continuation of
    // the owner's agent's own run, or the target of another agent's request.
    // The original run carries the human request and its requester.
    let row: Option<(String, String, String)> = query_as(
        "SELECT root.request_message_id, root.requester_account_id, parent.owner_account_id
         FROM cloud_agent_exchanges e
         JOIN cloud_agent_fallback_runs run
           ON run.run_id = CASE WHEN $5 THEN e.resume_run_id ELSE e.target_run_id END
         JOIN cloud_agent_fallback_runs root ON root.run_id=e.root_run_id
         JOIN cloud_agent_fallback_runs parent ON parent.run_id=e.parent_run_id
         WHERE e.exchange_id=$1 AND run.request_message_id=$2
           AND run.session_id=$3 AND root.session_id=$3
           AND run.owner_account_id=$4 AND run.requester_account_id=root.requester_account_id
           AND (CASE WHEN $5 THEN root.owner_account_id=$4 ELSE e.target_owner_id=$4 END)
           AND run.subsession_id IS NULL AND run.parent_run_id IS NULL
           AND root.subsession_id IS NULL
           AND e.status NOT IN ('cancelled','failed','timed_out')",
    )
    .bind(exchange)
    .bind(request)
    .bind(session)
    .bind(account)
    .bind(resume)
    .fetch_optional(pool)
    .await?;
    let (human_request, requester, asking_owner) = row.ok_or(RunError::NotFound)?;
    if human_request.starts_with(PREFIX) {
        return Err(RunError::NotFound);
    }
    Ok(Origin {
        human_request,
        requester: Some(requester),
        asking_owner: Some(asking_owner),
    })
}

/// The owner's "share busy/free with people in my chats" setting. A missing
/// account never shares.
async fn shares_availability(pool: &PgPool, account: &str) -> RunResult<bool> {
    let row: Option<(bool,)> =
        query_as("SELECT share_calendar_availability FROM cloud_accounts WHERE account_id=$1")
            .bind(account)
            .fetch_optional(pool)
            .await?;
    Ok(row.is_some_and(|row| row.0))
}

async fn active_members(pool: &PgPool, session: &str, members: &[String]) -> RunResult<bool> {
    let mut members = members.to_vec();
    members.sort();
    members.dedup();
    let (count,): (i64,) = query_as(
        "SELECT count(DISTINCT m.account_id) FROM cloud_chat_conversation_members m
         JOIN cloud_chat_conversations c ON c.conversation_id=m.conversation_id
         WHERE c.legacy_session_id=$1 AND m.account_id=ANY($2) AND m.membership_state='active'",
    )
    .bind(session)
    .bind(&members)
    .fetch_one(pool)
    .await?;
    Ok(usize::try_from(count).is_ok_and(|count| count == members.len()))
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
        assert_eq!(
            shared_disclosure(None, false, Member).unwrap(),
            Availability
        );
        assert!(shared_disclosure(None, true, Member).is_err());
        assert!(shared_disclosure(Some(Details), true, Member).is_err());
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
