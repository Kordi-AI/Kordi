//! "Rebuild automatically" (#2433) against the database: the settings body,
//! marking from memory writes and connector events, the sweep, an update
//! landing in place, a manual build winning, caps, and silent failures.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::db_fixture::{account, app, pool, send, signed_in};
use super::profile_memories_tests::{own, save};
use super::rematch_support::limiter;
use super::support::{build_card_with, card_reply, claim, claim_run, RUNNER};
use crate::common_ground::auto::{sweep, AutoRebuildConfig, Hold, Outcome};
use crate::common_ground::{complete, fail};

const CARD: &str = "/v1/cloud/common-ground/card";
pub(super) const SETTINGS: &str = "/v1/cloud/common-ground/settings";

pub(super) fn due_now() -> AutoRebuildConfig {
    AutoRebuildConfig {
        quiet_seconds: 0,
        max_wait_seconds: 0,
        ..AutoRebuildConfig::default()
    }
}

/// Sweeps until this card has an outcome; other cards may be swept too.
pub(super) async fn sweep_card(
    pool: &PgPool,
    service: &str,
    profile_id: &str,
    config: &AutoRebuildConfig,
) -> Option<Outcome> {
    let service = crate::system_agent::test_config(service);
    let limiter = limiter();
    // Each claim pushes the cards it took a minute out, so a few sweeps
    // reach this card even when other marked cards are waiting.
    for _ in 0..5 {
        let outcomes = sweep(pool, &service, &limiter, config).await.unwrap();
        if let Some((_, outcome)) = outcomes.into_iter().find(|(id, _)| id == profile_id) {
            return Some(outcome);
        }
    }
    None
}

pub(super) async fn view(app: &axum::Router, token: &str) -> Value {
    let (status, body) = send(app, "GET", CARD, token, None).await;
    assert_eq!(status, 200, "{body}");
    body
}

/// (profile id, auto run id, marked) of the account's card.
pub(super) async fn auto_state(pool: &PgPool, account: &str) -> (String, Option<String>, bool) {
    query_as(
        "SELECT profile_id, auto_run_id, auto_dirty_since IS NOT NULL
         FROM cloud_common_ground_cards WHERE account_id = $1",
    )
    .bind(account)
    .fetch_one(pool)
    .await
    .unwrap()
}

pub(super) async fn claim_auto(pool: &PgPool, account: &str) -> (String, String) {
    let (_, run_id, _) = auto_state(pool, account).await;
    let run_id = run_id.expect("an automatic update in flight");
    assert!(run_id.starts_with("cg_auto_"), "{run_id}");
    let lease = (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339();
    claim_run(pool, &run_id, &lease).await;
    let (prompt,): (String,) =
        query_as("SELECT prompt FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(pool)
            .await
            .unwrap();
    (run_id, prompt)
}

async fn automatic_hints(pool: &PgPool, account: &str) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_chat_user_sync_events WHERE account_id = $1
           AND event_type = 'common_ground.card.updated' AND payload->>'automatic' = 'true'",
    )
    .bind(account)
    .fetch_one(pool)
    .await
    .unwrap();
    count
}

#[tokio::test]
async fn settings_change_only_the_fields_they_name() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (owner, token) = signed_in(&pool, "Ada").await;
    let put = |body: Value| send(&app, "PUT", SETTINGS, &token, Some(body));
    let (status, body) = put(json!({})).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["errorCode"], "common_ground_invalid_settings");
    // An account without a card gets the setting on its work profile.
    let (status, body) = put(json!({"autoRebuild": true})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (
            &body["autoRebuild"],
            &body["autoUpdating"],
            &body["sharing"]
        ),
        (&json!(true), &json!(false), &json!(true))
    );
    build_card_with(
        &app,
        &pool,
        &owner,
        &token,
        &card_reply(&["Agent memory"], &[], &[], &[]),
    )
    .await;
    let revision = view(&app, &token).await["card"]["revision"]
        .as_i64()
        .unwrap();
    let (_, body) = put(json!({"sharing": false})).await;
    assert_eq!(
        (&body["sharing"], &body["autoRebuild"]),
        (&json!(false), &json!(true))
    );
    assert_eq!(
        body["card"]["revision"],
        revision + 1,
        "sharing moves the revision"
    );
    let (_, body) = put(json!({"autoRebuild": false})).await;
    assert_eq!(
        (&body["sharing"], &body["autoRebuild"]),
        (&json!(false), &json!(false))
    );
    assert_eq!(
        body["card"]["revision"],
        revision + 1,
        "the setting alone does not"
    );
    assert!(!auto_state(&pool, &owner).await.2);
    let (_, body) = put(json!({"sharing": true, "autoRebuild": true})).await;
    assert_eq!(
        (&body["sharing"], &body["autoRebuild"]),
        (&json!(true), &json!(true))
    );
    assert_eq!(body["card"]["revision"], revision + 2);
    assert!(
        auto_state(&pool, &owner).await.2,
        "turning it on looks for pending changes"
    );
}

#[tokio::test]
async fn memory_changes_land_in_place_and_failures_stay_silent() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (owner, token) = signed_in(&pool, "Grace").await;
    let reply = card_reply(&["Agent memory"], &["Retrieval"], &[], &[]);
    build_card_with(&app, &pool, &owner, &token, &reply).await;
    let (status, _) = send(
        &app,
        "PUT",
        &format!("{CARD}/hidden"),
        &token,
        Some(json!({"hidden": ["Retrieval"]})),
    )
    .await;
    assert_eq!(status, 200);
    // Without the setting a memory write marks nothing.
    save(
        &app,
        &token,
        own("Reviews retrieval papers", "work_context"),
    )
    .await;
    let (profile_id, _, marked) = auto_state(&pool, &owner).await;
    assert!(!marked);
    let (status, _) = send(
        &app,
        "PUT",
        SETTINGS,
        &token,
        Some(json!({"autoRebuild": true})),
    )
    .await;
    assert_eq!(status, 200);
    let config = due_now();
    // The pending memory lands after the quiet window.
    assert_eq!(
        sweep_card(&pool, &service, &profile_id, &config).await,
        Some(Outcome::Queued)
    );
    let body = view(&app, &token).await;
    assert_eq!(
        (&body["autoUpdating"], &body["build"]["status"]),
        (&json!(true), &json!("idle"))
    );
    let (run_id, prompt) = claim_auto(&pool, &owner).await;
    let (card_part, new_part) = prompt.split_once("New evidence:").unwrap();
    assert!(card_part.contains("Current card:") && card_part.contains("My work."));
    assert!(new_part.contains("Reviews retrieval papers"));
    assert!(!new_part.contains("My work."), "notes are not read again");
    // A change during the run leaves the card marked.
    save(
        &app,
        &token,
        own("Started the Atlas benchmark", "work_context"),
    )
    .await;
    assert!(auto_state(&pool, &owner).await.2);
    let revision = body["card"]["revision"].as_i64().unwrap();
    let update = json!({
        "add": [{"list": "can_help", "label": "Paper reviews", "evidence": [0]}],
        "drop": [{"label": "Agent memory", "evidence": [0]}, {"label": "Retrieval", "evidence": [0]}],
    });
    complete(&pool, &run_id, RUNNER, &update.to_string())
        .await
        .unwrap();
    let body = view(&app, &token).await;
    let card = &body["card"];
    // Topics from notes and hidden topics stay.
    assert_eq!(card["workingOn"], json!(["Agent memory"]));
    assert_eq!(card["interests"], json!(["Retrieval"]));
    assert_eq!(card["canHelp"], json!(["Paper reviews"]));
    assert_eq!(card["hidden"], json!(["Retrieval"]));
    assert_eq!(card["revision"], revision + 1);
    assert_eq!(
        (&body["autoUpdating"], &body["build"]["errorCode"]),
        (&json!(false), &Value::Null)
    );
    assert_eq!(automatic_hints(&pool, &owner).await, 1);
    // The second memory is new to the card, but the hourly cap holds it.
    let capped = AutoRebuildConfig {
        hourly_updates: 1,
        ..config
    };
    assert_eq!(
        sweep_card(&pool, &service, &profile_id, &capped).await,
        Some(Outcome::Held(Hold::Capped))
    );
    query("UPDATE cloud_common_ground_cards SET auto_retry_after = now() WHERE profile_id = $1")
        .bind(&profile_id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        sweep_card(&pool, &service, &profile_id, &config).await,
        Some(Outcome::Queued)
    );
    let (run_id, prompt) = claim_auto(&pool, &owner).await;
    assert!(prompt.contains("Started the Atlas benchmark"));
    assert!(
        !prompt.contains("[1]"),
        "what the last update took is not resent"
    );
    // A failed update changes nothing, shows no error and does not retry.
    fail(&pool, &run_id, Some(RUNNER), "common_ground_run_failed")
        .await
        .unwrap();
    let after = view(&app, &token).await;
    assert_eq!(after["card"], body["card"]);
    assert_eq!(
        (&after["build"]["status"], &after["build"]["errorCode"]),
        (&json!("idle"), &Value::Null)
    );
    assert_eq!(
        auto_state(&pool, &owner).await,
        (profile_id.clone(), None, false)
    );
    assert_eq!(
        sweep_card(&pool, &service, &profile_id, &config).await,
        None
    );
    assert_eq!(automatic_hints(&pool, &owner).await, 1);
}

#[tokio::test]
async fn a_manual_build_wins_over_an_automatic_update() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (owner, token) = signed_in(&pool, "Lin").await;
    build_card_with(
        &app,
        &pool,
        &owner,
        &token,
        &card_reply(&["Agent memory"], &[], &[], &[]),
    )
    .await;
    send(
        &app,
        "PUT",
        SETTINGS,
        &token,
        Some(json!({"autoRebuild": true})),
    )
    .await;
    save(
        &app,
        &token,
        own("Leads the sensor project", "work_context"),
    )
    .await;
    let (profile_id, _, _) = auto_state(&pool, &owner).await;
    let config = due_now();
    assert_eq!(
        sweep_card(&pool, &service, &profile_id, &config).await,
        Some(Outcome::Queued)
    );
    let (auto_run, _) = claim_auto(&pool, &owner).await;
    let (status, body) = send(
        &app,
        "POST",
        &format!("{CARD}/build"),
        &token,
        Some(json!({"notes": "Sensors."})),
    )
    .await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(
        (&body["build"]["status"], &body["autoUpdating"]),
        (&json!("building"), &json!(false))
    );
    // The automatic reply arrives late and is discarded.
    let update = json!({"add": [{"list": "interests", "label": "Late topic", "evidence": [0]}]});
    complete(&pool, &auto_run, RUNNER, &update.to_string())
        .await
        .unwrap();
    let (status,): (String,) =
        query_as("SELECT status FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&auto_run)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "completed");
    assert_eq!(view(&app, &token).await["card"]["interests"], json!([]));
    // No automatic update starts while the manual build is in flight.
    save(&app, &token, own("Mentors two interns", "work_context")).await;
    assert_eq!(
        sweep_card(&pool, &service, &profile_id, &config).await,
        Some(Outcome::Held(Hold::InFlight))
    );
    let manual = claim(&pool, &owner).await;
    complete(
        &pool,
        &manual,
        RUNNER,
        &card_reply(&["Sensor project"], &[], &[], &[]),
    )
    .await
    .unwrap();
    let body = view(&app, &token).await;
    assert_eq!(body["card"]["workingOn"], json!(["Sensor project"]));
    assert_eq!(automatic_hints(&pool, &owner).await, 0);
}

#[tokio::test]
async fn connector_events_mark_cards_that_pick_their_provider() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (owner, token) = signed_in(&pool, "Ravi").await;
    build_card_with(
        &app,
        &pool,
        &owner,
        &token,
        &card_reply(&["Agent memory"], &[], &[], &[]),
    )
    .await;
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
    assert_eq!(
        sweep_card(&pool, &service, &profile_id, &config).await,
        Some(Outcome::Cleared)
    );
    let connector = format!("cn_{owner}");
    query("INSERT INTO cloud_connectors (connector_id, account_id, provider, status) VALUES ($1, $2, 'github', 'connected')")
        .bind(&connector)
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_connector_agent_grants (connector_id, agent_id) VALUES ($1, $2)")
        .bind(&connector)
        .bind(format!("cloud-agent:{owner}"))
        .execute(&pool)
        .await
        .unwrap();
    let record = |external: &'static str| {
        let payload = json!({"title": format!("Merged the {external} retrieval fix")});
        let pool = pool.clone();
        let connector = connector.clone();
        async move {
            crate::connectors::events::record_event(
                &pool,
                crate::connectors::events::NewConnectorEvent {
                    connector_id: &connector,
                    provider: "github",
                    kind: "pull_request",
                    external_id: Some(external),
                    occurred_at: chrono::Utc::now(),
                    payload: &payload,
                },
            )
            .await
            .unwrap()
        }
    };
    // Not among the card's picks: nothing is marked.
    record("first").await.unwrap();
    assert!(!auto_state(&pool, &owner).await.2);
    query("UPDATE cloud_common_ground_profiles SET sources_json = $2 WHERE profile_id = $1")
        .bind(&profile_id)
        .bind(json!({"memory": false, "connectors": ["github"]}))
        .execute(&pool)
        .await
        .unwrap();
    record("second").await.unwrap();
    assert!(auto_state(&pool, &owner).await.2);
    assert_eq!(
        sweep_card(&pool, &service, &profile_id, &config).await,
        Some(Outcome::Queued)
    );
    let (_, prompt) = claim_auto(&pool, &owner).await;
    assert!(
        prompt.contains("GitHub · Merged the second retrieval fix"),
        "{prompt}"
    );
    assert!(
        prompt.contains("Merged the first retrieval fix"),
        "events since the build count"
    );
}
