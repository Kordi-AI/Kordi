//! `memoriesSinceBuild` with "Rebuild automatically" (#2433): memories an
//! automatic update read stop counting even when it changed nothing, and
//! only those.

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;

use super::auto_rebuild_tests::{auto_state, claim_auto, due_now, sweep_card, view, SETTINGS};
use super::db_fixture::{account, app, pool, send, signed_in};
use super::profile_memories_tests::{own, save};
use super::support::{build_card_with, card_reply, claim, RUNNER};
use crate::common_ground::auto::Outcome;
use crate::common_ground::complete;

/// `memoriesSinceBuild` in the owner view and in the profile list.
async fn counts(app: &axum::Router, token: &str) -> (Value, Value) {
    let card = view(app, token).await["memoriesSinceBuild"].clone();
    let (status, body) = send(app, "GET", "/v1/cloud/common-ground/profiles", token, None).await;
    assert_eq!(status, 200, "{body}");
    (card, body["profiles"][0]["memoriesSinceBuild"].clone())
}

#[tokio::test]
async fn memories_an_update_read_stop_counting_even_without_a_change() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (owner, token) = signed_in(&pool, "Noor").await;
    let reply = card_reply(&["Agent memory"], &[], &[], &[]);
    build_card_with(&app, &pool, &owner, &token, &reply).await;
    let (status, _) = send(
        &app,
        "PUT",
        SETTINGS,
        &token,
        Some(json!({"autoRebuild": true})),
    )
    .await;
    assert_eq!(status, 200);
    save(&app, &token, own("Had lunch with the team", "work_context")).await;
    assert_eq!(counts(&app, &token).await, (json!(1), json!(1)));
    let (profile_id, _, _) = auto_state(&pool, &owner).await;
    let config = due_now();
    assert_eq!(
        sweep_card(&pool, &service, &profile_id, &config).await,
        Some(Outcome::Queued)
    );
    let before = view(&app, &token).await["card"].clone();
    let (run_id, _) = claim_auto(&pool, &owner).await;
    let nothing = json!({"add": [], "revise": [], "drop": []});
    complete(&pool, &run_id, RUNNER, &nothing.to_string())
        .await
        .unwrap();
    // The card is untouched, and the memory it read no longer counts.
    assert_eq!(view(&app, &token).await["card"], before);
    assert_eq!(counts(&app, &token).await, (json!(0), json!(0)));
    save(
        &app,
        &token,
        own("Leads the Atlas pipeline", "work_context"),
    )
    .await;
    assert_eq!(counts(&app, &token).await, (json!(1), json!(1)));
    // Memories written while the setting is off still count.
    send(
        &app,
        "PUT",
        SETTINGS,
        &token,
        Some(json!({"autoRebuild": false})),
    )
    .await;
    save(
        &app,
        &token,
        own("Reviews retrieval papers", "work_context"),
    )
    .await;
    assert_eq!(counts(&app, &token).await, (json!(2), json!(2)));
    // A manual build reads everything and forgets what updates had read.
    let (status, body) = send(
        &app,
        "POST",
        "/v1/cloud/common-ground/card/build",
        &token,
        Some(json!({"notes": "My work.", "memory": true})),
    )
    .await;
    assert_eq!(status, 202, "{body}");
    let manual = claim(&pool, &owner).await;
    complete(&pool, &manual, RUNNER, &reply).await.unwrap();
    let (seen,): (Option<chrono::DateTime<chrono::Utc>>,) =
        query_as("SELECT auto_seen_at FROM cloud_common_ground_cards WHERE profile_id = $1")
            .bind(&profile_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(seen, None);
    assert_eq!(counts(&app, &token).await, (json!(0), json!(0)));
}

async fn auto_runs(pool: &sqlx_postgres::PgPool, profile_id: &str) -> i64 {
    let (count,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_common_ground_auto_runs WHERE profile_id = $1")
            .bind(profile_id)
            .fetch_one(pool)
            .await
            .unwrap();
    count
}

#[tokio::test]
async fn saving_a_cited_memory_again_needs_no_update() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (owner, token) = signed_in(&pool, "Iris").await;
    let reply = card_reply(&["Agent memory"], &[], &[], &[]);
    build_card_with(&app, &pool, &owner, &token, &reply).await;
    send(
        &app,
        "PUT",
        SETTINGS,
        &token,
        Some(json!({"autoRebuild": true})),
    )
    .await;
    let (profile_id, _, _) = auto_state(&pool, &owner).await;
    let config = due_now();
    // Turning the setting on finds nothing new yet.
    assert_eq!(
        sweep_card(&pool, &service, &profile_id, &config).await,
        Some(Outcome::Cleared)
    );
    let memory = own("Runs the Atlas evaluations", "work_context");
    save(&app, &token, memory.clone()).await;
    assert_eq!(
        sweep_card(&pool, &service, &profile_id, &config).await,
        Some(Outcome::Queued)
    );
    let (run_id, _) = claim_auto(&pool, &owner).await;
    let update = json!({"add": [{"list": "can_help", "label": "Evaluations", "evidence": [0]}]});
    complete(&pool, &run_id, RUNNER, &update.to_string())
        .await
        .unwrap();
    let card = view(&app, &token).await["card"].clone();
    assert_eq!(card["canHelp"], json!(["Evaluations"]));
    assert_eq!(counts(&app, &token).await, (json!(0), json!(0)));
    // An agent saves the same text again: the row is only touched.
    let (status, body) = send(&app, "POST", "/v1/cloud/memory", &token, Some(memory)).await;
    assert!(status == 200 || status == 201, "{status} {body}");
    assert!(
        auto_state(&pool, &owner).await.2,
        "the save still marks the card"
    );
    assert_eq!(
        sweep_card(&pool, &service, &profile_id, &config).await,
        Some(Outcome::Cleared)
    );
    assert_eq!(auto_runs(&pool, &profile_id).await, 1, "no second run");
    assert_eq!(auto_state(&pool, &owner).await, (profile_id, None, false));
    assert_eq!(view(&app, &token).await["card"], card, "nothing changed");
    assert_eq!(counts(&app, &token).await, (json!(0), json!(0)));
}
