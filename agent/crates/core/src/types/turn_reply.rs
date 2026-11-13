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
//! - The last non-empty part is the final answer and is always kept, with
//!   one exception: a status preamble (see [`is_status_preamble`]) is the
//!   final answer only when it is the turn's last text. When a tool call or
//!   an assistant message without text follows it, it only announced that
//!   work, so it is left out like any other preamble and the last earlier
//!   substantive part is the final answer. A turn with no such part has an
//!   empty reply, and the caller supplies its own fallback.
//! - An earlier part is left out when it is a status preamble, an exact
//!   duplicate of a part already kept, or text the final answer already
//!   contains.
//! - Kept parts are trimmed and joined by a blank line.
//! - A final answer that is one JSON object, bare or as the only content of
//!   one fenced code block, is a machine-readable outcome (for example
//!   `{"agentExchangeOutcome":"waiting"}`), so it stays the whole reply and no
//!   earlier text is joined to it.
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
/// `ends_with_text` is false when a tool call or an assistant message without
/// text came after the last non-empty part.
fn reply_part_indexes(parts: &[&str], ends_with_text: bool) -> Vec<usize> {
    let Some(mut final_index) = parts.iter().rposition(|part| !part.trim().is_empty()) else {
        return Vec::new();
    };
    if !ends_with_text && is_status_preamble(parts[final_index]) {
        let substantive = parts[..final_index].iter().rposition(|part| {
            let part = part.trim();
            !part.is_empty() && !is_status_preamble(part)
        });
        match substantive {
            Some(index) => final_index = index,
            None => return Vec::new(),
        }
    }
    let final_answer = parts[final_index].trim();
    if is_machine_outcome(final_answer) {
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

/// One JSON object, bare or as the only content of one fenced code block.
fn is_machine_outcome(text: &str) -> bool {
    is_json_object(text) || fenced_block(text).is_some_and(is_json_object)
}

fn is_json_object(text: &str) -> bool {
    text.starts_with('{')
        && serde_json::from_str::<Value>(text).is_ok_and(|value| value.is_object())
}

/// The trimmed content of `text` when it is exactly one fenced code block,
/// with or without a language tag such as `json`.
fn fenced_block(text: &str) -> Option<&str> {
    let body = text.strip_prefix("```")?.strip_suffix("```")?;
    let (tag, content) = body.split_once('\n')?;
    let tag = tag.trim();
    let plain_tag = tag
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    (plain_tag && !content.contains("```")).then(|| content.trim())
}

/// The reply composed from a turn's assistant text parts; see the module rule.
/// Trailing empty parts mean the turn's last messages wrote no text (see
/// [`assistant_text_parts`]).
pub fn compose_turn_reply<S: AsRef<str>>(parts: &[S]) -> String {
    let parts = parts.iter().map(AsRef::as_ref).collect::<Vec<_>>();
    let ends_with_text = parts.last().is_some_and(|part| !part.trim().is_empty());
    reply_part_indexes(&parts, ends_with_text)
        .into_iter()
        .map(|index| parts[index].trim())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Applies the reply rule to a finished turn's segments and returns the
/// reply. Clients show the last non-empty text segment as the reply, so that
/// segment becomes the whole reply; each other segment folded into it is
/// emptied (with a new revision), so the disclosure does not show its text a
/// second time. A trailing status preamble that is not the final answer is
/// replaced by the reply. Preambles and other segments left out of the reply
/// are untouched, and an empty reply leaves every segment as it was.
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
    let Some(last_text) = parts.iter().rposition(|part| !part.trim().is_empty()) else {
        return String::new();
    };
    let ends_with_text = !segments[text_indexes[last_text] + 1..]
        .iter()
        .any(|segment| matches!(segment, TurnSegment::Tool { .. }));
    let kept = reply_part_indexes(&parts, ends_with_text);
    let reply = kept
        .iter()
        .map(|&index| parts[index].trim())
        .collect::<Vec<_>>()
        .join("\n\n");
    if kept.is_empty() {
        return reply;
    }
    for &part in kept.iter().filter(|&&part| part != last_text) {
        set_segment_text(&mut segments[text_indexes[part]], String::new());
    }
    set_segment_text(&mut segments[text_indexes[last_text]], reply.clone());
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
/// An assistant message without text adds one empty part, so the reply rule
/// sees a turn that ended on a tool call or a message without text.
pub fn assistant_text_parts(messages: &[Value]) -> Vec<String> {
    let mut parts = Vec::new();
    for message in messages {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let texts = assistant_message_texts(message);
        if texts.is_empty() {
            parts.push(String::new());
        } else {
            parts.extend(texts);
        }
    }
    parts
}

/// The text parts of one assistant message, without reasoning or tool calls.
pub fn assistant_message_texts(message: &Value) -> Vec<String> {
    match message.get("content") {
        Some(Value::String(text)) => vec![text.clone()],
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
#[path = "turn_reply_tests.rs"]
mod tests;
