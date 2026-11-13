//! Helpers for the matching-again tests: sweep ticks, card marks, stored
//! matches and open runs.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::db_fixture::send;
use super::support::answer_match;
use crate::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter};
use crate::common_ground::auto::{sweep, AutoRebuildConfig};

pub(super) const CG: &str = "/v1/cloud/common-ground";

/// A fresh in-process limiter, as the test router uses.
pub(super) fn limiter() -> CloudRateLimiter {
    CloudRateLimiter::memory(CloudRateLimitConfig::production())
}

/// The account's only profile.
pub(super) async fn profile_of(pool: &PgPool, account: &str) -> String {
    let (id,): (String,) =
        query_as("SELECT profile_id FROM cloud_common_ground_profiles WHERE account_id = $1")
            .bind(account)
            .fetch_one(pool)
            .await
            .unwrap();
    id
}

/// The card's mark, if any.
pub(super) async fn mark(pool: &PgPool, profile: &str) -> Option<DateTime<Utc>> {
    let (at,): (Option<DateTime<Utc>>,) =
        query_as("SELECT rematch_at FROM cloud_common_ground_cards WHERE profile_id = $1")
            .bind(profile)
            .fetch_one(pool)
            .await
            .unwrap();
    at
}

/// Whether the card is marked and due now.
pub(super) async fn due(pool: &PgPool, profile: &str) -> bool {
    mark(pool, profile).await.is_some_and(|at| at <= Utc::now())
}

/// Makes a held mark due now, as the minute it waits would.
pub(super) async fn look_again_now(pool: &PgPool, profile: &str) {
    query("UPDATE cloud_common_ground_cards SET rematch_at = now() WHERE profile_id = $1")
        .bind(profile)
        .execute(pool)
        .await
        .unwrap();
}

/// Runs sweep ticks until none of these cards has a due mark: each was
/// cleared or is held for a later look. Marks other tests left go first.
pub(super) async fn tick(pool: &PgPool, limiter: &CloudRateLimiter, profiles: &[&str]) {
    let service = crate::system_agent::service_account_id().unwrap();
    let service = crate::system_agent::test_config(service);
    let config = AutoRebuildConfig::default();
    for _ in 0..200 {
        sweep(pool, &service, limiter, &config).await.unwrap();
        let mut waiting = false;
        for profile in profiles {
            waiting |= due(pool, profile).await;
        }
        if !waiting {
            return;
        }
    }
    panic!("the sweep never reached these cards");
}

/// Match runs ever queued for this viewer.
pub(super) async fn match_runs(pool: &PgPool, viewer: &str) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_common_ground_match_runs
         WHERE kind = 'match' AND viewer_account_id = $1",
    )
    .bind(viewer)
    .fetch_one(pool)
    .await
    .unwrap();
    count
}

/// The account ids of the cards the viewer's open match run reads, in
/// prompt order; empty without an open run.
pub(super) async fn open_cards(pool: &PgPool, viewer: &str) -> Vec<String> {
    let row: Option<(Value,)> = query_as(
        "SELECT cards_json FROM cloud_common_ground_match_runs
         WHERE kind = 'match' AND viewer_account_id = $1 AND finished_at IS NULL
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(viewer)
    .fetch_optional(pool)
    .await
    .unwrap();
    row.map(|(cards,)| {
        cards
            .as_array()
            .unwrap()
            .iter()
            .map(|card| card["accountId"].as_str().unwrap().to_string())
            .collect()
    })
    .unwrap_or_default()
}

/// The stored match for `viewer` with `other` (profiles): when it was
/// opened, and whether it is current for both cards.
pub(super) async fn stored(
    pool: &PgPool,
    viewer: &str,
    other: &str,
) -> (Option<DateTime<Utc>>, bool) {
    query_as(
        "SELECT m.opened_at, mine.revision = m.viewer_revision AND theirs.revision = m.other_revision
         FROM cloud_common_ground_matches m
         JOIN cloud_common_ground_cards mine ON mine.profile_id = m.viewer_profile_id
         JOIN cloud_common_ground_cards theirs ON theirs.profile_id = m.other_profile_id
         WHERE m.viewer_profile_id = $1 AND m.other_profile_id = $2",
    )
    .bind(viewer)
    .bind(other)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Matches `viewer` with everyone in the room through its results,
/// answering each run, so every pair has a stored match.
pub(super) async fn match_room(
    app: &axum::Router,
    pool: &PgPool,
    code: &str,
    viewer: &str,
    token: &str,
) {
    let results = format!("{CG}/rooms/{code}/results");
    for _ in 0..4 {
        let (status, body) = send(app, "POST", &results, token, None).await;
        assert_eq!(status, 200, "{body}");
        if open_cards(pool, viewer).await.is_empty() {
            return;
        }
        answer_match(pool, viewer).await;
    }
    panic!("the room never finished matching");
}

/// Opens the match between two people who see each other, matching them
/// first when needed, so it is stored and in the viewer's Recent.
pub(super) async fn open_match(
    app: &axum::Router,
    pool: &PgPool,
    viewer: (&str, &str),
    other: &str,
) {
    let detail = format!("{CG}/people/{other}/match");
    let (status, body) = send(app, "GET", &detail, viewer.1, None).await;
    if status == 202 {
        answer_match(pool, viewer.0).await;
        let (status, body) = send(app, "GET", &detail, viewer.1, None).await;
        assert_eq!(status, 200, "{body}");
    } else {
        assert_eq!(status, 200, "{body}");
    }
}

/// Pairs two people with cards.
pub(super) async fn pair(app: &axum::Router, token: &str, other_token: &str) {
    let (status, body) = send(app, "POST", &format!("{CG}/pairings/code"), token, None).await;
    assert_eq!(status, 201, "{body}");
    let redeem = json!({"code": body["code"]});
    let path = format!("{CG}/pairings/redeem");
    let (status, body) = send(app, "POST", &path, other_token, Some(redeem)).await;
    assert_eq!(status, 200, "{body}");
}
