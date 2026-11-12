//! What the System agent is shown, and whether it needs to look at all.
//!
//! Every run is a paid model call, so two things happen before one is queued:
//! a free text check decides whether new messages could be about a plan, and
//! the snapshot the model sees is kept small no matter how long the chat or
//! how large the group is.

use std::collections::BTreeSet;

use serde_json::{json, Value};

use crate::plan_cards::models::{PlanCardRow, PlanCardRsvp};

/// Recent messages fetched for a run.
pub(crate) const CONTEXT_MESSAGE_FETCH: i64 = 30;
/// Characters kept from a single message.
pub(crate) const MESSAGE_CHAR_LIMIT: usize = 400;
/// Characters of message text across the whole snapshot.
pub(crate) const MESSAGE_CHAR_BUDGET: usize = 6_000;
/// Members listed by name; the rest are only counted.
pub(crate) const MEMBER_LIST_LIMIT: usize = 40;
/// Card participants listed by name in a large group.
pub(crate) const PARTICIPANT_LIST_LIMIT: usize = 30;

/// One chat message as fetched for a run.
pub(crate) struct ContextMessage {
    pub id: String,
    pub sequence: i64,
    pub sender_id: String,
    pub sender_name: String,
    pub kind: String,
    pub text: String,
    pub created_at: String,
}

/// Keeps the newest messages that fit the character budget, oldest first,
/// with each message cut to a readable length. Messages without text (card
/// messages) are left out; the open card is its own field.
pub(crate) fn budget_messages(
    mut newest_first: Vec<ContextMessage>,
    context_start_sequence: i64,
    seen_sequence: i64,
    system_agent_account_id: &str,
) -> Vec<Value> {
    newest_first.retain(|message| {
        message.sequence > context_start_sequence && !message.text.trim().is_empty()
    });
    let mut used = 0usize;
    let mut kept = Vec::new();
    for mut message in newest_first {
        if message.text.chars().count() > MESSAGE_CHAR_LIMIT {
            message.text = message
                .text
                .chars()
                .take(MESSAGE_CHAR_LIMIT)
                .collect::<String>()
                + "…";
        }
        let size = message.text.chars().count();
        if used + size > MESSAGE_CHAR_BUDGET && !kept.is_empty() {
            break;
        }
        used += size;
        kept.push(message);
    }
    kept.reverse();
    kept.into_iter()
        .map(|message| {
            json!({
                "messageId": message.id,
                "sequence": message.sequence,
                "isNew": message.sequence > seen_sequence,
                "senderId": message.sender_id,
                "senderName": message.sender_name,
                "fromSystemAgent": message.sender_id == system_agent_account_id,
                "kind": message.kind,
                "text": message.text,
                "createdAt": message.created_at,
            })
        })
        .collect()
}

/// The card as the System agent needs it: every field that drives a decision,
/// with vote and participant lists reduced to counts plus the people the System
/// agent may need to name once a group is large.
pub(crate) fn compact_card(row: &PlanCardRow) -> Value {
    let count = |rsvp: PlanCardRsvp| row.participants.iter().filter(|p| p.rsvp == rsvp).count();
    let total = row.participants.len();
    let small = total <= PARTICIPANT_LIST_LIMIT;
    let person = |participant: &crate::plan_cards::models::PlanCardParticipantStatus| {
        json!({
            "participantId": participant.account_id,
            "displayName": participant.display_name,
            "organizer": participant.organizer,
            "rsvp": participant.rsvp.as_db_str(),
        })
    };
    let participants: Vec<Value> = if small {
        row.participants.iter().map(person).collect()
    } else {
        // Organizers first, then people who have not answered (the ones worth
        // nudging), then a few who declined.
        let organizers = row.participants.iter().filter(|p| p.organizer);
        let pending = row
            .participants
            .iter()
            .filter(|p| !p.organizer && p.rsvp == PlanCardRsvp::Pending)
            .take(20);
        let declined = row
            .participants
            .iter()
            .filter(|p| !p.organizer && p.rsvp == PlanCardRsvp::No)
            .take(10);
        organizers
            .chain(pending)
            .chain(declined)
            .take(PARTICIPANT_LIST_LIMIT)
            .map(person)
            .collect()
    };
    let voters: BTreeSet<&str> = row
        .options
        .iter()
        .flat_map(|option| option.votes.iter().map(String::as_str))
        .collect();
    json!({
        "eventId": row.event_id,
        "revision": row.revision,
        "state": row.state.as_db_str(),
        "title": row.title,
        "startAt": row.start_at,
        "endAt": row.end_at,
        "location": row.location,
        "unresolvedFields": row.unresolved_fields,
        "options": row.options.iter().map(|option| {
            let mut value = json!({
                "id": option.id,
                "label": option.label,
                "startAt": option.start_at,
                "endAt": option.end_at,
                "location": option.location,
                "voteCount": option.votes.len(),
            });
            if small {
                value["voterIds"] = json!(option.votes);
            }
            value
        }).collect::<Vec<_>>(),
        "counts": {
            "participants": total,
            "going": count(PlanCardRsvp::Yes),
            "declined": count(PlanCardRsvp::No),
            "pending": count(PlanCardRsvp::Pending),
            "voted": voters.len(),
        },
        "participants": participants,
        "participantsTruncated": !small,
    })
}

/// Members listed for a run: everyone in a small group; in a large one the
/// people speaking in the snapshot and on the card come first, then others
/// up to the limit.
pub(crate) fn pick_members<'a, T>(
    members: &'a [T],
    account_id: impl Fn(&T) -> &str,
    featured: &BTreeSet<String>,
) -> Vec<&'a T> {
    if members.len() <= MEMBER_LIST_LIMIT {
        return members.iter().collect();
    }
    let (first, rest): (Vec<&T>, Vec<&T>) = members
        .iter()
        .partition(|member| featured.contains(account_id(member)));
    first
        .into_iter()
        .chain(rest)
        .take(MEMBER_LIST_LIMIT)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_budget_excludes_pre_join_history_and_marks_only_unseen_messages() {
        let long = "x".repeat(MESSAGE_CHAR_LIMIT + 100);
        let messages: Vec<ContextMessage> = (0..30)
            .rev()
            .map(|sequence| ContextMessage {
                id: format!("m{sequence}"),
                sequence,
                sender_id: "acct_a".into(),
                sender_name: "A".into(),
                kind: "text".into(),
                text: long.clone(),
                created_at: String::new(),
            })
            .collect();
        let kept = budget_messages(messages, 10, 27, "acct_system_agent");
        assert!(kept.len() < 30);
        assert!(kept
            .iter()
            .all(|message| message["sequence"].as_i64().unwrap() > 10));
        assert_eq!(kept.last().unwrap()["sequence"], 29);
        assert_eq!(kept.last().unwrap()["isNew"], true);
        assert_eq!(
            kept.iter()
                .filter(|message| message["isNew"] == true)
                .count(),
            2
        );
        assert!(kept
            .iter()
            .all(|m| m["text"].as_str().unwrap().chars().count() <= MESSAGE_CHAR_LIMIT + 1));
    }
}
