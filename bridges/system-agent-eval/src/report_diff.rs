//! What differs between two runs: the fixtures each ran and the checks that
//! passed in one and failed in the other.

use std::collections::{BTreeMap, BTreeSet};

use crate::report::RunReport;
use crate::score::Check;

/// Fixture ids only the candidate has (added) and only the baseline has
/// (removed). Different sets make the totals incomparable.
pub fn fixture_set_diff(baseline: &RunReport, candidate: &RunReport) -> (Vec<String>, Vec<String>) {
    let ids = |report: &RunReport| -> BTreeSet<String> {
        report.fixtures.iter().map(|f| f.id.clone()).collect()
    };
    let (base, other) = (ids(baseline), ids(candidate));
    (
        other.difference(&base).cloned().collect(),
        base.difference(&other).cloned().collect(),
    )
}

/// Every check of a run by a stable key: fixture, pass, check name and its
/// occurrence within the pass.
fn keyed_checks(report: &RunReport) -> BTreeMap<String, &Check> {
    let mut keyed = BTreeMap::new();
    for fixture in &report.fixtures {
        for (index, pass) in fixture.passes.iter().enumerate() {
            let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
            for check in &pass.checks {
                let count = seen.entry(&check.name).or_default();
                *count += 1;
                keyed.insert(
                    format!(
                        "{} / pass {} / {} #{}",
                        fixture.id,
                        index + 1,
                        check.name,
                        count
                    ),
                    check,
                );
            }
        }
    }
    keyed
}

/// Checks that pass in `from` and fail in `to`.
pub(crate) fn flipped(from: &RunReport, to: &RunReport) -> Vec<(String, Option<String>)> {
    let before = keyed_checks(from);
    keyed_checks(to)
        .into_iter()
        .filter(|(key, check)| !check.passed && before.get(key).is_some_and(|c| c.passed))
        .map(|(key, check)| {
            (
                key.trim_end_matches(" #1").to_string(),
                check.detail.clone(),
            )
        })
        .collect()
}
