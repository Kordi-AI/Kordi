//! Numbers over each Grounding match suite, measured once per repeat: how
//! well scores separate labelled pairs, whether strong partners reach a
//! room viewer's top three, how often strong pairs score high, how many
//! proposed pairs the server drops, how often a finding reads the same to
//! either person, and whether the two directions of a pair agree.

use std::collections::{BTreeMap, BTreeSet};

use crate::match_run::{Cause, MatchOutcome};
use crate::match_suite::{MatchFixture, Strength};
use crate::report_numbers::{combine, Measure, Number};

/// One finding of one run, with the suite's label for the pair.
#[derive(Debug, Clone, PartialEq)]
pub struct Observation {
    pub suite: String,
    /// The room of a room run.
    pub room: Option<String>,
    pub viewer: String,
    pub other: String,
    pub strength: Option<Strength>,
    pub score: i64,
    /// Kept shared pairs as (viewer's topic, other person's topic).
    pub shared: BTreeSet<(String, String)>,
    pub proposed: usize,
    pub kept: usize,
    pub reads_for_either: bool,
    pub cause: Option<Cause>,
}

/// The findings of one run; none when the run failed.
pub fn observe(fixture: &MatchFixture, outcome: &MatchOutcome) -> Vec<Observation> {
    let Some(findings) = &outcome.findings else {
        return Vec::new();
    };
    fixture
        .others
        .iter()
        .zip(&fixture.labels)
        .zip(findings)
        .map(|((other, label), finding)| Observation {
            suite: fixture.suite.clone(),
            room: fixture.room.clone(),
            viewer: fixture.viewer.id.clone(),
            other: other.id.clone(),
            strength: label.map(|label| label.strength),
            score: finding.score,
            shared: finding
                .shared
                .iter()
                .map(|pair| (pair.topic.clone(), pair.their_topic.clone()))
                .collect(),
            proposed: finding.proposed,
            kept: finding.kept,
            reads_for_either: finding.reads_for_either,
            cause: finding.cause,
        })
        .collect()
}

/// The chance that a random positive scores above a random negative, equal
/// scores counting half; `None` without both.
pub fn auc(positives: &[i64], negatives: &[i64]) -> Option<f64> {
    if positives.is_empty() || negatives.is_empty() {
        return None;
    }
    let mut wins = 0.0;
    for positive in positives {
        for negative in negatives {
            wins += match positive.cmp(negative) {
                std::cmp::Ordering::Greater => 1.0,
                std::cmp::Ordering::Equal => 0.5,
                std::cmp::Ordering::Less => 0.0,
            };
        }
    }
    Some(wins / (positives.len() * negatives.len()) as f64)
}

/// Whether the three highest scores above zero include a strong partner,
/// and how many people labelled none they include. Equal scores keep the
/// order given.
pub fn top_three(
    ranked: &[(&str, i64)],
    strong: &BTreeSet<&str>,
    none: &BTreeSet<&str>,
) -> (bool, usize) {
    let mut ranked: Vec<&(&str, i64)> = ranked.iter().filter(|(_, score)| *score > 0).collect();
    ranked.sort_by_key(|(_, score)| std::cmp::Reverse(*score));
    let top = &ranked[..ranked.len().min(3)];
    (
        top.iter().any(|(person, _)| strong.contains(person)),
        top.iter()
            .filter(|(person, _)| none.contains(person))
            .count(),
    )
}

/// The overlap of two sets; `None` when both are empty.
pub fn jaccard<T: Ord>(a: &BTreeSet<T>, b: &BTreeSet<T>) -> Option<f64> {
    let union = a.union(b).count();
    (union > 0).then(|| a.intersection(b).count() as f64 / union as f64)
}

fn rate(part: usize, whole: usize) -> Option<f64> {
    (whole > 0).then(|| part as f64 / whole as f64)
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

/// One suite's numbers in one repeat. A number that nothing measured is
/// left out.
pub fn suite_measures(suite: &str, observations: &[&Observation]) -> Vec<Measure> {
    let mut out = Vec::new();
    let mut push = |metric: &str, value: Option<f64>, samples: usize| {
        if let Some(value) = value {
            out.push(Measure::new(format!("{suite}/{metric}"), value, samples));
        }
    };
    let scores = |wanted: &[Strength]| -> Vec<i64> {
        observations
            .iter()
            .filter(|o| {
                o.strength
                    .is_some_and(|strength| wanted.contains(&strength))
            })
            .map(|o| o.score)
            .collect()
    };
    let strong = scores(&[Strength::Strong]);
    let labelled = scores(&[Strength::Strong, Strength::Weak]);
    let none = scores(&[Strength::None]);
    push(
        "auc_strong_vs_none",
        auc(&strong, &none),
        strong.len() + none.len(),
    );
    push(
        "auc_strong_weak_vs_none",
        auc(&labelled, &none),
        labelled.len() + none.len(),
    );

    // A room viewer's batches together, in the room's member order.
    let mut viewers: BTreeMap<(&str, &str), Vec<&Observation>> = BTreeMap::new();
    for o in observations {
        if let Some(room) = &o.room {
            viewers
                .entry((room.as_str(), o.viewer.as_str()))
                .or_default()
                .push(o);
        }
    }
    let (mut considered, mut hits, mut none_in_top) = (0, 0, 0);
    for found in viewers.values() {
        let with = |strength: Strength| -> BTreeSet<&str> {
            found
                .iter()
                .filter(|o| o.strength == Some(strength))
                .map(|o| o.other.as_str())
                .collect()
        };
        let strong_partners = with(Strength::Strong);
        if strong_partners.is_empty() {
            continue;
        }
        let ranked: Vec<(&str, i64)> = found.iter().map(|o| (o.other.as_str(), o.score)).collect();
        let (hit, nones) = top_three(&ranked, &strong_partners, &with(Strength::None));
        considered += 1;
        hits += usize::from(hit);
        none_in_top += nones;
    }
    push("top3_hit_rate", rate(hits, considered), considered);
    push(
        "top3_none_count",
        (considered > 0).then_some(none_in_top as f64),
        considered,
    );
    for threshold in [50, 70, 85] {
        let above = strong.iter().filter(|score| **score >= threshold).count();
        push(
            &format!("strong_score_at_least_{threshold}"),
            rate(above, strong.len()),
            strong.len(),
        );
    }

    let proposed: usize = observations.iter().map(|o| o.proposed).sum();
    let kept: usize = observations.iter().map(|o| o.kept).sum();
    push(
        "dropped_pair_rate",
        rate(proposed.saturating_sub(kept), proposed),
        proposed,
    );

    let found: Vec<&&Observation> = observations.iter().filter(|o| o.kept > 0).collect();
    let count = |keep: &dyn Fn(&Observation) -> bool| found.iter().filter(|o| keep(o)).count();
    let total = found.len();
    push(
        "either_person_rate",
        rate(count(&|o| o.reads_for_either), total),
        total,
    );
    for (metric, cause) in [
        ("either_person_second_person_rate", Cause::SecondPerson),
        ("either_person_name_rate", Cause::Name),
    ] {
        push(
            metric,
            rate(count(&|o| o.cause == Some(cause)), total),
            total,
        );
    }

    let mut directed: BTreeMap<(&str, &str), &Observation> = BTreeMap::new();
    for o in observations {
        directed
            .entry((o.viewer.as_str(), o.other.as_str()))
            .or_insert(o);
    }
    let (mut overlaps, mut differences) = (Vec::new(), Vec::new());
    for (&(viewer, other), forward) in &directed {
        let Some(back) = directed.get(&(other, viewer)).filter(|_| viewer < other) else {
            continue;
        };
        let swapped: BTreeSet<(String, String)> = back
            .shared
            .iter()
            .map(|(a, b)| (b.clone(), a.clone()))
            .collect();
        overlaps.extend(jaccard(&forward.shared, &swapped));
        if forward.score > 0 || back.score > 0 {
            differences.push((forward.score - back.score).abs() as f64);
        }
    }
    push("direction_shared_jaccard", mean(&overlaps), overlaps.len());
    push(
        "direction_score_difference",
        mean(&differences),
        differences.len(),
    );
    out
}

/// Every suite's numbers, from the observations of each repeat, suites in
/// the order they first appear.
pub fn numbers(repeats: &[Vec<Observation>]) -> Vec<Number> {
    let measures: Vec<Vec<Measure>> = repeats
        .iter()
        .map(|observations| {
            let mut suites: Vec<&str> = Vec::new();
            for o in observations {
                if !suites.contains(&o.suite.as_str()) {
                    suites.push(&o.suite);
                }
            }
            suites
                .into_iter()
                .flat_map(|suite| {
                    let of_suite: Vec<&Observation> =
                        observations.iter().filter(|o| o.suite == suite).collect();
                    suite_measures(suite, &of_suite)
                })
                .collect()
        })
        .collect();
    combine(&measures)
}

#[cfg(test)]
#[path = "match_metrics_tests.rs"]
mod tests;
