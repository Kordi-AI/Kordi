//! The reply text of one agent turn.
//!
//! A model can write user-facing text in several assistant messages of one
//! turn: for example a full summary next to a tool call, then a closing
//! question after that call fails. Codex labels the earlier text with the
//! `commentary` phase and the last text with `final_answer`. Clients show the
//! last text segment as the reply and fold every earlier segment into the
//! collapsed "Worked for" disclosure, so a summary written before the last
//! tool call never reached the reader. A turn's reply therefore keeps every
//! substantive text part in order, with the final answer last.
//!
//! The rule, applied to a turn's assistant text parts (never reasoning):
//! - The last non-empty part is the final answer and is always kept.
//! - An earlier part is left out when it is a status preamble (see
//!   [`is_status_preamble`]), an exact duplicate of a part already kept, or
//!   text the final answer already contains.
//! - Kept parts are trimmed and joined by a blank line.
//! - A final answer that is one JSON object is a machine-readable outcome
//!   (for example `{"agentExchangeOutcome":"waiting"}`), so it stays the
//!   whole reply and no earlier text is joined to it.
//!
//! A preamble left out of the reply stays a text segment, so clients still
//! show it in the turn's activity disclosure.

use serde_json::Value;

use super::TurnSegment;

/// A status preamble is shorter than this many characters.
pub const STATUS_PREAMBLE_MAX_CHARS: usize = 80;

/// Whether `text` only announces work, like "Checking your notifications:" or
/// "Looking at Slack…": one line, shorter than
/// [`STATUS_PREAMBLE_MAX_CHARS`], ending in a colon or an ellipsis. Clients
/// already show such progress lines in the activity disclosure; repeating
/// them in the reply adds nothing.
pub fn is_status_preamble(text: &str) -> bool {
    let text = text.trim();
    !text.is_empty()
        && text.chars().count() < STATUS_PREAMBLE_MAX_CHARS
        && !text.contains('\n')
        && (text.ends_with(':') || text.ends_with('…') || text.ends_with("..."))
}

/// The indexes of the parts that form the reply, in order, final answer last.
fn reply_part_indexes(parts: &[&str]) -> Vec<usize> {
    let Some(final_index) = parts.iter().rposition(|part| !part.trim().is_empty()) else {
        return Vec::new();
    };
    let final_answer = parts[final_index].trim();
    if is_json_object(final_answer) {
        return vec![final_index];
    }
    let mut kept: Vec<usize> = Vec::new();
    for (index, part) in parts[..final_index].iter().enumerate() {
        let part = part.trim();
        if part.is_empty()
            || is_status_preamble(part)
            || final_answer.contains(part)
            || kept.iter().any(|&kept| parts[kept].trim() == part)
        {
            continue;
        }
        kept.push(index);
    }
    kept.push(final_index);
    kept
}

fn is_json_object(text: &str) -> bool {
    text.starts_with('{')
        && serde_json::from_str::<Value>(text).is_ok_and(|value| value.is_object())
}

/// The reply composed from a turn's assistant text parts; see the module rule.
pub fn compose_turn_reply<S: AsRef<str>>(parts: &[S]) -> String {
    let parts = parts.iter().map(AsRef::as_ref).collect::<Vec<_>>();
    reply_part_indexes(&parts)
        .into_iter()
        .map(|index| parts[index].trim())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Applies the reply rule to a finished turn's segments and returns the
/// reply. The last non-empty text segment becomes the whole reply; each
/// earlier segment folded into it is emptied (with a new revision), so the
/// disclosure does not show its text a second time. Preambles and other
/// segments left out of the reply are untouched.
pub fn fold_turn_reply_segments(segments: &mut [TurnSegment]) -> String {
    let text_indexes = segments
        .iter()
        .enumerate()
        .filter_map(|(index, segment)| matches!(segment, TurnSegment::Text { .. }).then_some(index))
        .collect::<Vec<_>>();
    let parts = text_indexes
        .iter()
        .map(|&index| match &segments[index] {
            TurnSegment::Text { text, .. } => text.as_str(),
            TurnSegment::Tool { .. } => unreachable!("only text segments are indexed"),
        })
        .collect::<Vec<_>>();
    let kept = reply_part_indexes(&parts);
    let reply = kept
        .iter()
        .map(|&index| parts[index].trim())
        .collect::<Vec<_>>()
        .join("\n\n");
    let Some((&final_part, folded)) = kept.split_last() else {
        return reply;
    };
    for &part in folded {
        set_segment_text(&mut segments[text_indexes[part]], String::new());
    }
    set_segment_text(&mut segments[text_indexes[final_part]], reply.clone());
    reply
}

fn set_segment_text(segment: &mut TurnSegment, value: String) {
    if let TurnSegment::Text { text, revision, .. } = segment
        && *text != value
    {
        *text = value;
        *revision = revision.saturating_add(1);
    }
}

/// The text parts of the assistant messages in `messages`, in order, from
/// Kordi messages in their JSON form (for example an OMP run's new messages).
pub fn assistant_text_parts(messages: &[Value]) -> Vec<String> {
    let mut parts = Vec::new();
    for message in messages {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        match message.get("content") {
            Some(Value::String(text)) => parts.push(text.clone()),
            Some(Value::Array(blocks)) => parts.extend(
                blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .map(str::to_string),
            ),
            _ => {}
        }
    }
    parts
}

#[cfg(test)]
#[path = "turn_reply_tests.rs"]
mod tests;
