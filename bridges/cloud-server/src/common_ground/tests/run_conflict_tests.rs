//! Many match runs of one room finishing at once, and how long a failed run
//! holds the viewer's next one back.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};

use super::db_fixture::send;
use super::support::{answer_themes, claim_run, open_runs, people_in_a_room, RUNNER};
use crate::common_ground::{complete, fail};

/// The room's open match runs and the account ids of the cards each read.
async fn open_match_runs(pool: &sqlx_postgres::PgPool, code: &str) -> Vec<(String, usize)> {
    let rows: Vec<(String, Value)> = query_as(
        "SELECT m.run_id, m.cards_json FROM cloud_common_ground_match_runs m
         JOIN cloud_common_ground_rooms r ON r.room_id = m.room_id
         WHERE r.code = $1 AND r.closed_at IS NULL AND m.kind = 'match' AND m.finished_at IS NULL",
    )
    .bind(code)
    .fetch_all(pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|(run_id, cards)| (run_id, cards.as_array().map_or(0, Vec::len)))
        .collect()
}

/// Lists a run's other people in reverse, the viewer still first.
async fn reverse_people(pool: &sqlx_postgres::PgPool, run_id: &str) {
    let (cards,): (Value,) =
        query_as("SELECT cards_json FROM cloud_common_ground_match_runs WHERE run_id = $1")
            .bind(run_id)
            .fetch_one(pool)
            .await
            .unwrap();
    let mut cards = cards.as_array().unwrap().clone();
    cards[1..].reverse();
    query("UPDATE cloud_common_ground_match_runs SET cards_json = $2 WHERE run_id = $1")
        .bind(run_id)
        .bind(Value::Array(cards))
        .execute(pool)
        .await
        .unwrap();
}

/// A reply finding "Agent memory" with everyone a run read, worded so it
/// is stored for both people.
fn everyone_shares(cards: usize) -> String {
    let people: Vec<Value> = (0..cards.saturating_sub(1))
        .map(|i| json!({"person": i, "shared": [{"mine": "Agent memory", "theirs": "Agent memory", "why": "Both work on agent memory"}], "next_step": "Compare notes"}))
        .collect();
    json!({ "people": people }).to_string()
}

#[tokio::test]
async fn overlapping_runs_that_store_both_sides_finish_together() {
    let Some(pool) = super::db_fixture::pool().await else {
        return;
    };
    let labels: Vec<String> = (0..10).map(|i| format!("Crowd{i}")).collect();
    let labels: Vec<&str> = labels.iter().map(String::as_str).collect();
    let (app, code, people) = people_in_a_room(&pool, &labels).await;
    let results = format!("/v1/cloud/common-ground/rooms/{code}/results");
    for (_, token) in &people {
        let (status, body) = send(&app, "POST", &results, token, None).await;
        assert_eq!(status, 200, "{body}");
    }
    answer_themes(&pool, &[]).await;
    let runs = open_match_runs(&pool, &code).await;
    assert!(runs.len() >= 2, "overlapping runs: {}", runs.len());
    // Each viewer's own estimates order their run's people; in this room all
    // estimates tie, so every other run lists them backwards, as differing
    // estimates would.
    for (run_id, _) in runs.iter().skip(1).step_by(2) {
        reverse_people(&pool, run_id).await;
    }
    let lease = (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339();
    for (run_id, _) in &runs {
        claim_run(&pool, run_id, &lease).await;
    }

    // Every run stores rows and refreshes accounts the others touch too.
    let mut finishing = tokio::task::JoinSet::new();
    for (run_id, cards) in runs.clone() {
        let pool = pool.clone();
        finishing
            .spawn(async move { complete(&pool, &run_id, RUNNER, &everyone_shares(cards)).await });
    }
    while let Some(done) = finishing.join_next().await {
        done.unwrap().unwrap();
    }
    let ids: Vec<&String> = runs.iter().map(|(run_id, _)| run_id).collect();
    let (unfinished, failed): (i64, i64) = query_as(
        "SELECT COUNT(*) FILTER (WHERE finished_at IS NULL), COUNT(*) FILTER (WHERE error_code IS NOT NULL)
         FROM cloud_common_ground_match_runs WHERE run_id = ANY($1)",
    )
    .bind(&ids)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((unfinished, failed), (0, 0));
}

#[tokio::test]
async fn a_rate_limited_run_holds_the_next_one_back_only_briefly() {
    let Some(pool) = super::db_fixture::pool().await else {
        return;
    };
    let labels: Vec<String> = (0..8).map(|i| format!("Busy{i}")).collect();
    let labels: Vec<&str> = labels.iter().map(String::as_str).collect();
    let (app, code, people) = people_in_a_room(&pool, &labels).await;
    let results = format!("/v1/cloud/common-ground/rooms/{code}/results");
    let (viewer, token) = &people[0];
    send(&app, "POST", &results, token, None).await;
    answer_themes(&pool, &[]).await;

    // Each failure is made 30 seconds old: past the hold for a rate limit,
    // within the two minutes for any other failure.
    let age = |run_id: String| {
        let pool = pool.clone();
        async move {
            query("UPDATE cloud_common_ground_match_runs SET finished_at = now() - interval '30 seconds' WHERE run_id = $1")
                .bind(run_id)
                .execute(&pool)
                .await
                .unwrap();
        }
    };
    let (run_id, _) = open_match_runs(&pool, &code).await.remove(0);
    fail(&pool, &run_id, None, "common_ground_rate_limited")
        .await
        .unwrap();
    age(run_id).await;
    let (status, body) = send(&app, "POST", &results, token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "matching", "{body}");
    assert_eq!(open_runs(&pool, viewer).await, 1, "queued again");

    let (run_id, _) = open_match_runs(&pool, &code).await.remove(0);
    fail(&pool, &run_id, None, "common_ground_run_failed")
        .await
        .unwrap();
    age(run_id).await;
    let (status, body) = send(&app, "POST", &results, token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "failed", "{body}");
    assert_eq!(open_runs(&pool, viewer).await, 0, "held back");
}
