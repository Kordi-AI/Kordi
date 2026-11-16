//! A room's results say "matching" until everyone a run can match has a
//! model result: between background runs and while one pauses after a
//! failure, so a client never sees "ready" beside rows still to come.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};

use super::db_fixture::send;
use super::support::{answer_themes, claim_open, people_in_a_room, RUNNER};
use crate::common_ground::{complete, fail};

/// A match reply that finds nothing in common with anyone it read.
const NOTHING_IN_COMMON: &str = r#"{"people":[{"person":0,"shared":[],"next_step":""}]}"#;

fn estimated(body: &Value) -> Vec<String> {
    body["people"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["estimated"] == json!(true))
        .map(|p| p["person"]["accountId"].as_str().unwrap().to_string())
        .collect()
}

/// Unfinished match runs the viewer asked for (theme runs left out).
async fn open_matches(pool: &sqlx_postgres::PgPool, viewer: &str) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_common_ground_match_runs
         WHERE kind = 'match' AND viewer_account_id = $1 AND finished_at IS NULL",
    )
    .bind(viewer)
    .fetch_one(pool)
    .await
    .unwrap();
    count
}

#[tokio::test]
async fn a_room_stays_matching_until_every_person_who_can_be_matched_is() {
    let Some(pool) = super::db_fixture::pool().await else {
        return;
    };
    let labels: Vec<String> = (0..8).map(|i| format!("Wait{i}")).collect();
    let labels: Vec<&str> = labels.iter().map(String::as_str).collect();
    let (app, code, people) = people_in_a_room(&pool, &labels).await;
    let results = format!("/v1/cloud/common-ground/rooms/{code}/results");
    let (viewer, token) = &people[0];
    let (_, body) = send(&app, "POST", &results, token, None).await;
    assert_eq!(body["status"], "matching", "{body}");
    answer_themes(&pool, &[]).await;
    let (best, _) = claim_open(&pool, "match", Some(viewer)).await;
    complete(&pool, &best, RUNNER, NOTHING_IN_COMMON)
        .await
        .unwrap();

    // The best five are in; the last two follow in a background run.
    let (status, body) = send(&app, "POST", &results, token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "matching", "{body}");
    let rest = estimated(&body);
    assert_eq!(rest.len(), 2, "{body}");

    // While that run pauses after a failure, the rows still to come keep
    // the room matching, and nothing is queued until the pause ends.
    let (tail, _) = claim_open(&pool, "match", Some(viewer)).await;
    fail(&pool, &tail, None, "common_ground_run_failed")
        .await
        .unwrap();
    let (status, body) = send(&app, "POST", &results, token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "matching", "{body}");
    assert_eq!(estimated(&body).len(), 2);
    assert_eq!(open_matches(&pool, viewer).await, 0, "held back");

    // Someone who declines AI keeps their estimate and holds nothing up.
    query("UPDATE cloud_accounts SET ai_consent_status = 'declined' WHERE account_id = $1")
        .bind(&rest[0])
        .execute(&pool)
        .await
        .unwrap();
    query("UPDATE cloud_common_ground_match_runs SET finished_at = now() - interval '3 minutes' WHERE run_id = $1")
        .bind(&tail)
        .execute(&pool)
        .await
        .unwrap();
    let (_, body) = send(&app, "POST", &results, token, None).await;
    assert_eq!(body["status"], "matching", "{body}");
    let (tail, cards) = claim_open(&pool, "match", Some(viewer)).await;
    assert_eq!(cards, vec![viewer.clone(), rest[1].clone()]);
    complete(&pool, &tail, RUNNER, NOTHING_IN_COMMON)
        .await
        .unwrap();
    let (status, body) = send(&app, "POST", &results, token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "ready", "{body}");
    assert_eq!(estimated(&body), vec![rest[0].clone()]);
    assert_eq!(open_matches(&pool, viewer).await, 0);
}

#[tokio::test]
async fn a_finished_background_run_hints_the_viewer_and_the_people_it_read() {
    let Some(pool) = super::db_fixture::pool().await else {
        return;
    };
    let labels: Vec<String> = (0..8).map(|i| format!("Hint{i}")).collect();
    let labels: Vec<&str> = labels.iter().map(String::as_str).collect();
    let (app, code, people) = people_in_a_room(&pool, &labels).await;
    let results = format!("/v1/cloud/common-ground/rooms/{code}/results");
    let (viewer, token) = &people[0];
    send(&app, "POST", &results, token, None).await;
    answer_themes(&pool, &[]).await;
    let (best, _) = claim_open(&pool, "match", Some(viewer)).await;
    complete(&pool, &best, RUNNER, NOTHING_IN_COMMON)
        .await
        .unwrap();
    send(&app, "POST", &results, token, None).await;
    let (tail, cards) = claim_open(&pool, "match", Some(viewer)).await;
    assert!(tail.starts_with("cg_match_brief_"), "{tail}");

    let hints = |account: String| {
        let pool = pool.clone();
        async move {
            let (count,): (i64,) = query_as(
                "SELECT COUNT(*) FROM cloud_chat_user_sync_events
                 WHERE account_id = $1 AND event_type = 'common_ground.matches.updated'",
            )
            .bind(account)
            .fetch_one(&pool)
            .await
            .unwrap();
            count
        }
    };
    let mut before = Vec::new();
    for account in &cards {
        before.push(hints(account.clone()).await);
    }
    complete(&pool, &tail, RUNNER, NOTHING_IN_COMMON)
        .await
        .unwrap();
    for (account, before) in cards.iter().zip(before) {
        assert_eq!(hints(account.clone()).await, before + 1, "{account}");
    }
}
