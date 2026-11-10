//! Plan cards that contradict each other: two live cards whose times
//! overlap, or two cards for what looks like the same plan at different times
//! within a day.

use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};

use super::triggers::{similarity, word_set, Finding};

/// How alike two card titles must be to read as one plan.
const SAME_PLAN: f64 = 0.5;
/// A card without an end time is taken to last this long.
const DEFAULT_LENGTH_MINUTES: i64 = 60;
const CONFLICT_PREFIX: &str = "conflict:";

/// One live plan card in the conversation.
#[derive(Clone, Debug)]
pub(super) struct CardFact {
    pub event_id: String,
    pub title: String,
    pub start_at: Option<DateTime<Utc>>,
    pub end_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub created_by: String,
    pub by_system_agent: bool,
}

impl CardFact {
    fn window(&self) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
        let start = self.start_at?;
        let end = self
            .end_at
            .filter(|end| *end > start)
            .unwrap_or(start + Duration::minutes(DEFAULT_LENGTH_MINUTES));
        Some((start, end))
    }

    fn shown(&self) -> Value {
        json!({
            "eventId": self.event_id,
            "title": self.title,
            "startAt": self.start_at,
            "endAt": self.end_at,
            "createdBySystemAgent": self.by_system_agent,
        })
    }
}

/// Whether two titles name the same plan: most of their words are shared, or
/// every word of one is in the other.
fn same_plan(left: &str, right: &str) -> bool {
    let (left, right) = (word_set(left), word_set(right));
    if left.is_empty() || right.is_empty() {
        return false;
    }
    left.is_subset(&right) || right.is_subset(&left) || similarity(&left, &right) >= SAME_PLAN
}

/// Why two cards contradict each other, if they do.
fn contradiction(left: &CardFact, right: &CardFact) -> Option<&'static str> {
    let ((left_start, left_end), (right_start, right_end)) = (left.window()?, right.window()?);
    if left_start < right_end && right_start < left_end {
        return Some("overlap");
    }
    let apart = (left_start - right_start).abs();
    (apart <= Duration::hours(24) && same_plan(&left.title, &right.title))
        .then_some("different_times")
}

/// The first pair of contradicting cards not flagged yet.
pub(super) fn find_conflict(cards: &[CardFact], hooks_fired: &Value) -> Option<Finding> {
    for (index, left) in cards.iter().enumerate() {
        for right in &cards[index + 1..] {
            let Some(reason) = contradiction(left, right) else {
                continue;
            };
            let (a, b) = if left.event_id <= right.event_id {
                (left, right)
            } else {
                (right, left)
            };
            let key = format!("{CONFLICT_PREFIX}{}|{}", a.event_id, b.event_id);
            if hooks_fired.get(&key).is_some() {
                continue;
            }
            return Some(Finding {
                detail: json!({
                    "kind": "conflict",
                    "reason": reason,
                    "cards": [a.shown(), b.shown()],
                }),
                marks: json!({ key: true }),
                // Whoever made the newer card someone else did not make.
                ask: [a, b]
                    .into_iter()
                    .filter(|card| !card.by_system_agent)
                    .max_by_key(|card| card.created_at)
                    .map(|card| card.created_by.clone()),
            });
        }
    }
    None
}
