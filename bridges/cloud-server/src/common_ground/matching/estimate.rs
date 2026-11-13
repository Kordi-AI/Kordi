//! A quick match from topic words, with no model run, so a large room shows
//! everyone ranked at once. Two topics match by the words they share,
//! weighted so words many people in the room use ("AI", "data") count less
//! than rare ones, and two shared words in a row count extra. The estimate
//! is scored with the same weights as a model finding ([`super::score`]),
//! so a model result that replaces it reads on the same scale. Its reasons
//! and next step are empty: only a model run writes those.

use std::collections::{HashMap, HashSet};

use super::{headline, prompt::Found, MatchResult, Reason, SharedCard, Trade};
use crate::common_ground::card::Topics;

/// Topics this similar or more count as the same area.
const SAME_AREA: f64 = 0.34;
/// At most this many pairs per list, as a match run returns.
const MAX_PAIRS: usize = 2;
/// Extra weight for each pair of words two topics share in the same order.
const PHRASE_BONUS: f64 = 0.5;

const STOP_WORDS: [&str; 40] = [
    "a", "an", "and", "the", "of", "for", "to", "in", "on", "with", "at", "by", "from", "or", "as",
    "into", "about", "via", "using", "use", "based", "my", "our", "new", "how", "what", "is",
    "are", "be", "it", "its", "that", "this", "vs", "etc", "other", "more", "better", "work",
    "working",
];

/// The words of a topic, lower case, with stop words dropped and plurals
/// folded ("agents" and "agent" are one word).
fn words(topic: &str) -> Vec<String> {
    topic
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .filter(|word| !STOP_WORDS.contains(&word.as_str()))
        .map(|word| singular(&word))
        .collect()
}

fn singular(word: &str) -> String {
    let chars = word.chars().count();
    if chars > 4 && word.ends_with("ies") {
        format!("{}y", &word[..word.len() - 3])
    } else if chars > 3
        && word.ends_with('s')
        && !["ss", "us", "is"].iter().any(|end| word.ends_with(end))
    {
        word[..word.len() - 1].to_string()
    } else {
        word.to_string()
    }
}

/// How rare each word is among a set of cards: `ln(1 + cards / cards with
/// the word)`. A word no card has counts as if one card had it.
#[derive(Debug, Default)]
pub(in crate::common_ground) struct Rarity {
    cards: f64,
    seen: HashMap<String, f64>,
}

impl Rarity {
    pub fn of(cards: &[SharedCard]) -> Self {
        let mut seen: HashMap<String, f64> = HashMap::new();
        for card in cards {
            let unique: HashSet<String> = all_topics(&card.topics).flat_map(|t| words(t)).collect();
            for word in unique {
                *seen.entry(word).or_default() += 1.0;
            }
        }
        Self {
            cards: cards.len().max(1) as f64,
            seen,
        }
    }

    fn weight(&self, word: &str) -> f64 {
        let with = self.seen.get(word).copied().unwrap_or(1.0).max(1.0);
        (1.0 + self.cards / with).ln()
    }
}

fn all_topics(topics: &Topics) -> impl Iterator<Item = &String> {
    topics
        .working_on
        .iter()
        .chain(&topics.interests)
        .chain(&topics.can_help)
        .chain(&topics.looking_for)
}

/// 0-1: how much two topics are about the same thing. Same label is 1.
fn similarity(a: &[String], b: &[String], rarity: &Rarity) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    let a_set: HashSet<&String> = a.iter().collect();
    let b_set: HashSet<&String> = b.iter().collect();
    let shared: f64 = a_set.intersection(&b_set).map(|w| rarity.weight(w)).sum();
    if shared == 0.0 {
        return 0.0;
    }
    let union: f64 = a_set.union(&b_set).map(|w| rarity.weight(w)).sum();
    let a_pairs: HashSet<(&String, &String)> = a.iter().zip(a.iter().skip(1)).collect();
    let phrases = b
        .iter()
        .zip(b.iter().skip(1))
        .filter(|pair| a_pairs.contains(pair))
        .count() as f64;
    ((shared / union) * (1.0 + PHRASE_BONUS * phrases)).min(1.0)
}

struct Topic<'a> {
    label: &'a String,
    words: Vec<String>,
    /// 1 for "working on" (or "looking for" as a trade target), less for
    /// interests, as in [`super::score`].
    weight: f64,
}

fn topics<'a>(list: &'a [String], weight: f64) -> impl Iterator<Item = Topic<'a>> {
    list.iter().map(move |label| Topic {
        label,
        words: words(label),
        weight,
    })
}

/// The best pairs of (left, right) topics, each topic used once, best
/// first, with their similarity.
fn best_pairs<'a>(
    left: &'a [Topic<'a>],
    right: &'a [Topic<'a>],
    rarity: &Rarity,
) -> Vec<(&'a Topic<'a>, &'a Topic<'a>, f64)> {
    let mut candidates: Vec<(usize, usize, f64)> = Vec::new();
    for (i, l) in left.iter().enumerate() {
        for (j, r) in right.iter().enumerate() {
            let sim = similarity(&l.words, &r.words, rarity);
            if sim >= SAME_AREA {
                candidates.push((i, j, sim * l.weight.min(r.weight)));
            }
        }
    }
    candidates.sort_by(|a, b| b.2.total_cmp(&a.2).then(a.0.cmp(&b.0)).then(a.1.cmp(&b.1)));
    let (mut used_left, mut used_right) = (HashSet::new(), HashSet::new());
    let mut out = Vec::new();
    for (i, j, value) in candidates {
        if out.len() == MAX_PAIRS {
            break;
        }
        if used_left.contains(&i) || used_right.contains(&j) {
            continue;
        }
        used_left.insert(i);
        used_right.insert(j);
        out.push((&left[i], &right[j], value));
    }
    out
}

/// What `giver` can help with that serves `receiver`, best first.
fn trades(giver: &Topics, receiver: &Topics, rarity: &Rarity) -> (Vec<Trade>, f64) {
    let offers: Vec<Topic> = topics(&giver.can_help, 1.0).collect();
    let targets: Vec<Topic> = topics(&receiver.looking_for, super::WORKING_ON)
        .chain(topics(&receiver.working_on, super::OTHER_FIELD))
        .chain(topics(&receiver.interests, super::OTHER_FIELD))
        .collect();
    let pairs = best_pairs(&offers, &targets, rarity);
    let value = pairs.iter().map(|(_, _, value)| value).sum();
    let trades = pairs
        .into_iter()
        .map(|(offer, target, _)| Trade {
            topic: offer.label.clone(),
            target: target.label.clone(),
            why: String::new(),
        })
        .collect();
    (trades, value)
}

/// The quick match of `viewer` with `other`, as the viewer sees it.
pub(in crate::common_ground) fn estimate(
    viewer: &SharedCard,
    other: &SharedCard,
    rarity: &Rarity,
) -> MatchResult {
    let mine: Vec<Topic> = topics(&viewer.topics.working_on, super::WORKING_ON)
        .chain(topics(&viewer.topics.interests, super::OTHER_FIELD))
        .collect();
    let theirs: Vec<Topic> = topics(&other.topics.working_on, super::WORKING_ON)
        .chain(topics(&other.topics.interests, super::OTHER_FIELD))
        .collect();
    let pairs = best_pairs(&mine, &theirs, rarity);
    let overlap: f64 = pairs.iter().map(|(_, _, value)| value).sum();
    let shared: Vec<Reason> = pairs
        .into_iter()
        .map(|(mine, theirs, _)| Reason {
            topic: mine.label.clone(),
            their_topic: theirs.label.clone(),
            why: String::new(),
        })
        .collect();
    let (you_bring, you_value) = trades(&viewer.topics, &other.topics, rarity);
    let (they_bring, they_value) = trades(&other.topics, &viewer.topics, rarity);
    let found = Found {
        shared,
        you_bring,
        they_bring,
        next_step: String::new(),
    };
    let raw = super::OVERLAP_WEIGHT * super::saturate(overlap)
        + super::COMPLEMENT_WEIGHT * super::saturate(you_value + they_value);
    MatchResult {
        score: (raw * 100.0).round() as i64,
        headline: headline(&found),
        shared: found.shared,
        you_bring: found.you_bring,
        they_bring: found.they_bring,
        next_step: found.next_step,
    }
}

#[cfg(test)]
#[path = "estimate_tests.rs"]
mod tests;
