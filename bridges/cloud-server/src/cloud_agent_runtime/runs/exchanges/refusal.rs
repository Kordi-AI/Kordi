//! Why a request to an agent or person was not sent, for the asking agent.
//! An authorized run whose lease is still valid gets the reason (a 422 with
//! the message) so it can correct the call; a run that is not authorized
//! keeps the plain not-found answer and learns nothing about the directory.
use super::store::Parent;
use super::RunError;
use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

/// The person who asked is not among those this run may ask, as in the
/// owner's private chat, where every message already reaches the agent.
const REQUESTER_IN_REPLY: &str = "The person who asked cannot be asked with reach_out in this conversation. They read your reply here: ask them in your reply instead.";
const UNKNOWN_PERSON: &str = "That person is not someone you can ask for this request. Use an exact accountId or @handle from the runtime note.";
const UNKNOWN_AGENT: &str = "That agent is not reachable for this request. Use an exact agentId or @handle from the runtime note.";
pub(super) const AMBIGUOUS: &str =
    "That target names both an agent and a person. Set targetKind to agent or person.";
pub(super) const TARGET_KIND: &str = "targetKind must be agent or person.";
pub(super) const INVALID: &str =
    "The request needs a target and a message of at most 32,000 characters.";
pub(super) const ANSWERING: &str = "While answering another agent you may only ask your own owner.";
pub(super) const REUSED_CALL: &str = "This tool call was already used for a different request.";

pub(super) fn rejected(message: &'static str) -> RunError {
    RunError::ContextUnavailable(message)
}

/// Whether `target` names the requester: their account id, their public
/// handle, or their mention handle (the display name's letters and digits),
/// with or without a leading `@`.
fn matches_requester(
    requester: &str,
    name: Option<&str>,
    public_handle: Option<&str>,
    target: &str,
) -> bool {
    let target = target.trim();
    if target == requester {
        return true;
    }
    let key = super::person::normalized(target.trim_start_matches('@'));
    !key.is_empty()
        && [name, public_handle]
            .into_iter()
            .flatten()
            .any(|value| super::person::normalized(value) == key)
}

/// Whether `target` names the requester, reading their name and handle only
/// when the target is not their account id. A failed read counts as no.
async fn names_requester(pool: &PgPool, parent: &Parent, target: &str) -> bool {
    if target.trim() == parent.requester {
        return true;
    }
    let row: Option<(Option<String>, Option<String>)> =
        query_as("SELECT display_name,public_handle FROM cloud_accounts WHERE account_id=$1")
            .bind(&parent.requester)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    row.is_some_and(|(name, handle)| {
        matches_requester(
            &parent.requester,
            name.as_deref(),
            handle.as_deref(),
            target,
        )
    })
}

/// A person target this run may not ask.
pub(super) async fn person(pool: &PgPool, parent: &Parent, target: &str) -> RunError {
    rejected(if names_requester(pool, parent, target).await {
        REQUESTER_IN_REPLY
    } else {
        UNKNOWN_PERSON
    })
}

/// A person this run may no longer ask, by account id, inside a transaction.
pub(super) fn person_account(parent: &Parent, account_id: &str) -> RunError {
    rejected(if account_id == parent.requester {
        REQUESTER_IN_REPLY
    } else {
        UNKNOWN_PERSON
    })
}

/// An agent target this run may not reach. The requester's account id or
/// handle is a person the run cannot ask, not an agent.
pub(super) async fn agent(pool: &PgPool, parent: &Parent, target: &str) -> RunError {
    rejected(if names_requester(pool, parent, target).await {
        REQUESTER_IN_REPLY
    } else {
        UNKNOWN_AGENT
    })
}

/// Whether the person who made the request is among the people listed.
pub(crate) fn requester_listed(reachable: &Value) -> bool {
    reachable["people"]
        .as_array()
        .is_some_and(|people| people.iter().any(|p| p["requester"] == true))
}

/// The runtime note line naming whom this run can reach, and, when the
/// requester is not one of them, that the agent asks them in its reply.
pub(crate) fn note(reachable: &Value) -> String {
    let mut line = format!("You can reach_out to: {reachable}");
    if !requester_listed(reachable) {
        line.push_str(" The person who asked is not on this list: they read your reply here, so ask them in your reply, never with reach_out.");
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_requester_is_named_by_id_or_handle() {
        let named = |target| matches_requester("acct-1", Some("Ana Li"), Some("ana.li"), target);
        assert!(named("acct-1"));
        assert!(named(" @ana.li "));
        assert!(named("@AnaLi"));
        assert!(named("Ana Li"));
        assert!(!named("@priya"));
        assert!(!named("@"));
        assert!(!matches_requester("acct-1", None, None, "@ana"));
    }

    #[test]
    fn the_note_tells_the_agent_to_ask_an_unlisted_requester_in_its_reply() {
        let own_chat =
            json!({"agents":[{"agentId":"cloud-agent:o","ownerAccountId":"o"}],"people":[]});
        assert!(!requester_listed(&own_chat));
        assert!(note(&own_chat).contains("ask them in your reply, never with reach_out"));
        let shared = json!({"agents":[],"people":[{"accountId":"o","requester":true}]});
        assert!(requester_listed(&shared));
        assert!(!note(&shared).contains("in your reply"));
    }
}
