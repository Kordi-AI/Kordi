//! Why a request to an agent or person was not sent, for the asking agent.
//! An authorized run whose lease is still valid gets the reason (a 422 with
//! the message) so it can correct the call; a run that is not authorized
//! keeps the plain not-found answer and learns nothing about the directory.
use super::store::Parent;
use super::RunError;
use serde_json::Value;

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

fn names_requester(parent: &Parent, target: &str) -> bool {
    target.trim() == parent.requester
}

/// A person target this run may not ask.
pub(super) fn person(parent: &Parent, target: &str) -> RunError {
    rejected(if names_requester(parent, target) {
        REQUESTER_IN_REPLY
    } else {
        UNKNOWN_PERSON
    })
}

/// An agent target this run may not reach. A bare account id of the
/// requester is a person the run cannot ask, not an agent.
pub(super) fn agent(parent: &Parent, target: &str) -> RunError {
    rejected(if names_requester(parent, target) {
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
