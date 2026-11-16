//! A live comparison of a room's brief background match runs (topic labels
//! only, minimal effort) with full match runs on the same people. Ignored:
//! it calls the configured System agent provider. Run it with the provider
//! settings of `docs/testing/system-agent-quality.md` and
//! `KORDI_BRIEF_CHECK_CARDS`, a JSON list of cards
//! (`{name, workingOn, interests, canHelp, lookingFor}`):
//!
//! `cargo test -p kordi-system-agent-eval brief_check -- --ignored --nocapture`
//!
//! Each batch is one viewer and ten other people, run twice in full (the
//! second run shows how much full runs differ from each other) and once
//! brief. It prints the score differences, rank correlation, pairs that
//! cross between 0 and a score, and tokens and seconds per run.

use kordi_cloud_server::common_ground::quality::{
    MatchCard, MatchRun, MATCH_BRIEF_SYSTEM_PROMPT, MATCH_SYSTEM_PROMPT,
};
use serde_json::Value;

const BATCHES: usize = 6;
const PER_BATCH: usize = 10;

fn list(card: &Value, key: &str) -> Vec<String> {
    card[key]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|topic| topic.as_str().map(str::to_string))
        .collect()
}

fn card(value: &Value) -> MatchCard {
    MatchCard {
        name: value["name"].as_str().unwrap_or("Person").to_string(),
        working_on: list(value, "workingOn"),
        interests: list(value, "interests"),
        can_help: list(value, "canHelp"),
        looking_for: list(value, "lookingFor"),
    }
}

/// Ranks starting at 1, ties sharing their average rank.
fn ranks(values: &[f64]) -> Vec<f64> {
    let mut order: Vec<usize> = (0..values.len()).collect();
    order.sort_by(|a, b| values[*a].total_cmp(&values[*b]));
    let mut out = vec![0.0; values.len()];
    let mut start = 0;
    while start < order.len() {
        let mut end = start;
        while end + 1 < order.len() && values[order[end + 1]] == values[order[start]] {
            end += 1;
        }
        let rank = (start + end) as f64 / 2.0 + 1.0;
        for index in &order[start..=end] {
            out[*index] = rank;
        }
        start = end + 1;
    }
    out
}

fn pearson(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len() as f64;
    let (mean_a, mean_b) = (a.iter().sum::<f64>() / n, b.iter().sum::<f64>() / n);
    let cov: f64 = a
        .iter()
        .zip(b)
        .map(|(x, y)| (x - mean_a) * (y - mean_b))
        .sum();
    let var_a: f64 = a.iter().map(|x| (x - mean_a).powi(2)).sum();
    let var_b: f64 = b.iter().map(|y| (y - mean_b).powi(2)).sum();
    cov / (var_a * var_b).sqrt()
}

/// Mean absolute difference, Spearman correlation and 0/score crossings.
fn compare(a: &[i64], b: &[i64]) -> (f64, f64, usize) {
    let mad = a
        .iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs() as f64)
        .sum::<f64>()
        / a.len() as f64;
    let (fa, fb): (Vec<f64>, Vec<f64>) = (
        a.iter().map(|x| *x as f64).collect(),
        b.iter().map(|y| *y as f64).collect(),
    );
    let rho = pearson(&ranks(&fa), &ranks(&fb));
    let crossed = a
        .iter()
        .zip(b)
        .filter(|(x, y)| (**x == 0) != (**y == 0))
        .count();
    (mad, rho, crossed)
}

#[derive(Default)]
struct Kind {
    scores: Vec<i64>,
    seconds: Vec<f64>,
    input: Vec<u64>,
    output: Vec<u64>,
    failed: usize,
}

#[tokio::test]
#[ignore = "calls the configured provider"]
async fn brief_check() {
    let path = std::env::var("KORDI_BRIEF_CHECK_CARDS").expect("KORDI_BRIEF_CHECK_CARDS");
    let cards: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert!(cards.len() >= BATCHES * (PER_BATCH + 1), "need more cards");
    let settings = crate::setup::live_settings().unwrap();
    let config = settings.pending.unprovisioned();
    let kinds: [(&str, &'static str, &'static str); 3] = [
        ("full", MATCH_SYSTEM_PROMPT, "cg_match_"),
        ("full again", MATCH_SYSTEM_PROMPT, "cg_match_"),
        ("brief", MATCH_BRIEF_SYSTEM_PROMPT, "cg_match_brief_"),
    ];
    let engine = settings.engine;
    // A few calls at a time, so the provider's rate limit measures nothing.
    let slots = std::sync::Arc::new(tokio::sync::Semaphore::new(3));
    let mut tasks = tokio::task::JoinSet::new();
    for batch in 0..BATCHES {
        let start = batch * (PER_BATCH + 1);
        let viewer = card(&cards[start]);
        let others: Vec<MatchCard> = cards[start + 1..=start + PER_BATCH]
            .iter()
            .map(card)
            .collect();
        for (kind, &(_, prompt, prefix)) in kinds.iter().enumerate() {
            let run = MatchRun::new(&viewer, &others).with_system_prompt(prompt);
            let config = config.clone();
            let slots = slots.clone();
            tasks.spawn(async move {
                let _slot = slots.acquire_owned().await.unwrap();
                let (reply, latency_ms, usage) = crate::grounding::complete_as(
                    prefix,
                    &config,
                    engine,
                    &run.system_prompt,
                    &run.user_prompt,
                    None,
                )
                .await
                .unwrap();
                if let Err(error) = &reply {
                    eprintln!(
                        "{} failed: {}",
                        prefix,
                        crate::redact::provider_error(error)
                    );
                }
                let scores = reply
                    .ok()
                    .and_then(|text| run.parse(&text).ok())
                    .map(|found| found.iter().map(|f| f.score).collect::<Vec<i64>>());
                (batch, kind, scores, latency_ms, usage)
            });
        }
    }
    let mut results = Vec::new();
    while let Some(done) = tasks.join_next().await {
        results.push(done.unwrap());
    }
    results.sort_by_key(|r| (r.0, r.1));

    let mut by_kind: Vec<Kind> = kinds.iter().map(|_| Kind::default()).collect();
    // Pairs count only in batches where every kind finished.
    for batch in 0..BATCHES {
        let batch_results: Vec<_> = results.iter().filter(|r| r.0 == batch).collect();
        let complete = batch_results.iter().all(|r| r.2.is_some());
        for (_, kind, scores, latency_ms, usage) in batch_results {
            let entry = &mut by_kind[*kind];
            entry.seconds.push(*latency_ms as f64 / 1000.0);
            if let Some(usage) = usage {
                entry.input.push(usage.input_tokens);
                entry.output.push(usage.output_tokens);
            }
            match scores {
                Some(scores) if complete => entry.scores.extend(scores),
                Some(_) => {}
                None => entry.failed += 1,
            }
        }
    }
    let mean = |values: &[f64]| values.iter().sum::<f64>() / values.len().max(1) as f64;
    let mean_u = |values: &[u64]| mean(&values.iter().map(|v| *v as f64).collect::<Vec<_>>());
    for ((name, _, _), kind) in kinds.iter().zip(&by_kind) {
        let zero = kind.scores.iter().filter(|s| **s == 0).count();
        println!(
            "{name}: {} pairs ({zero} at 0), {} failed runs, {:.1} s/run, {:.0} tokens in, {:.0} out",
            kind.scores.len(),
            kind.failed,
            mean(&kind.seconds),
            mean_u(&kind.input),
            mean_u(&kind.output),
        );
    }
    for (a, b) in [(0, 1), (0, 2), (1, 2)] {
        let (mad, rho, crossed) = compare(&by_kind[a].scores, &by_kind[b].scores);
        println!(
            "{} vs {}: mean |difference| {mad:.1} points, Spearman {rho:.2}, {crossed} of {} pairs cross 0",
            kinds[a].0,
            kinds[b].0,
            by_kind[a].scores.len()
        );
    }
}

#[test]
fn ranks_share_ties_and_compare_counts_crossings() {
    assert_eq!(ranks(&[10.0, 0.0, 10.0, 5.0]), vec![3.5, 1.0, 3.5, 2.0]);
    let (mad, rho, crossed) = compare(&[0, 10, 20, 30], &[5, 10, 20, 0]);
    assert_eq!(mad, (5.0 + 30.0) / 4.0);
    assert_eq!(crossed, 2);
    assert!(rho < 1.0);
    let (_, same, _) = compare(&[1, 2, 3], &[10, 20, 30]);
    assert!((same - 1.0).abs() < 1e-9);
}
