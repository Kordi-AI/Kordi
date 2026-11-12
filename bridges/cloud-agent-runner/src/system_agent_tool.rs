//! The one tool System agent runs can call. The runner forwards every call to
//! the server, which binds it to the run's own conversation.

use serde_json::{json, Value};

pub const NAME: &str = "plan_card";

const DESCRIPTION: &str = "Propose a concrete event or scheduling poll. Only members vote, RSVP, confirm, cancel, or reopen a plan. A poll has two to four scheduling choices. For a single option use awaitingConfirmation. Include the existing event id and revision when updating an open proposal.";

/// The tool as the model sees it.
pub fn definition() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": NAME,
            "description": DESCRIPTION,
            "parameters": parameters(),
        }
    })
}

fn parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["propose"],
                "description": "Which plan-card operation to perform."
            },
            "options": {
                "type": "array",
                "description": "For a polling propose: 2 to 4 concrete choices the group votes on.",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "Optional stable id; assigned in order when omitted." },
                        "label": { "type": "string", "description": "Short choice text, e.g. 'Fri 7pm at Jordan's'." },
                        "startAt": { "type": "string", "description": "Optional RFC3339 start for this choice." },
                        "endAt": { "type": "string", "description": "Optional RFC3339 end for this choice." },
                        "location": { "type": "string" }
                    },
                    "required": ["label"],
                    "additionalProperties": false
                }
            },
            "conversationId": {
                "type": "string",
                "description": "Conversation this plan card belongs to. Required for propose."
            },
            "existingEventId": {
                "type": "string",
                "description": "When revising an existing plan, its event ID. Use the revision of the current proposal."
            },
            "existingRevision": {
                "type": "number",
                "description": "Revision of existingEventId being updated. Required whenever existingEventId is set."
            },
            "title": {
                "type": "string",
                "description": "Plan title, e.g. 'Lunch at Ramen Izakaya'. Required for propose."
            },
            "startAt": {
                "type": "string",
                "description": "Optional RFC3339 start instant."
            },
            "endAt": {
                "type": "string",
                "description": "Optional RFC3339 end instant."
            },
            "location": {
                "type": "string",
                "description": "Optional location text."
            },
            "state": {
                "type": "string",
                "enum": ["polling", "awaitingConfirmation"],
                "description": "Required for propose. 'polling' if agreement is still unclear or details are unresolved, 'awaitingConfirmation' if a single option looks settled but is not yet explicitly confirmed."
            },
            "unresolvedFields": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Names of fields still missing or undecided, e.g. ['location']."
            },
            "participants": {
                "type": "array",
                "description": "Group members involved in the plan.",
                "items": {
                    "type": "object",
                    "properties": {
                        "participantId": { "type": "string" },
                        "displayName": { "type": "string" },
                        "organizer": { "type": "boolean" }
                    },
                    "required": ["participantId", "displayName"],
                    "additionalProperties": false
                }
            },
            "sourceMessageIds": {
                "type": "array",
                "items": { "type": "string" },
                "description": "IDs of messages supporting this proposal."
            }
        },
        "required": ["action"],
        "additionalProperties": false
    })
}
