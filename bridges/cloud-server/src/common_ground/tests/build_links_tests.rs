//! Card builds that read links, and builds whose run never reported back.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_scalar::query_scalar};

use super::db_fixture::{account, app, pool, send, signed_in};
use super::support::{card_reply, claim, RUNNER};
use crate::common_ground::complete;

const BUILD: &str = "/v1/cloud/common-ground/card/build";
const CARD: &str = "/v1/cloud/common-ground/card";

#[tokio::test]
async fn a_link_that_cannot_be_read_is_named_on_the_card_and_kept_as_the_reference() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, token) = signed_in(&pool, "Alex").await;
    // `.test` never resolves, so the page cannot be fetched.
    let url = "https://scholar.example.test/citations?user=abc";
    let (status, body) = send(
        &app,
        "POST",
        BUILD,
        &token,
        Some(json!({"links": format!("{url}; {url}/"), "notes": "I work on agent evaluation."})),
    )
    .await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["build"]["status"], "building", "{body}");
    assert_eq!(
        body["build"]["unreadLinks"],
        json!([{"url": url, "reason": "unreachable"}]),
        "the same link twice is one source: {body}"
    );
    let prompt: String = query_scalar(
        "SELECT run.prompt FROM cloud_agent_fallback_runs run
         JOIN cloud_common_ground_cards card ON card.active_run_id = run.run_id
         WHERE card.account_id = $1",
    )
    .bind(&alex)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        prompt.contains("(This page could not be read.)"),
        "{prompt}"
    );
    assert_eq!(
        prompt.matches(url).count(),
        2,
        "title and text of one item: {prompt}"
    );

    let run_id = claim(&pool, &alex).await;
    let reply = card_reply(&["Agent evaluation"], &[], &[], &[]);
    complete(&pool, &run_id, RUNNER, &reply).await.unwrap();
    let (status, body) = send(&app, "GET", CARD, &token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["build"]["status"], "idle", "{body}");
    // The list stays with the card until the next build.
    assert_eq!(
        body["build"]["unreadLinks"],
        json!([{"url": url, "reason": "unreachable"}]),
        "{body}"
    );
}

#[tokio::test]
async fn a_build_whose_run_ended_without_reporting_back_shows_as_failed() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, token) = signed_in(&pool, "Alex").await;
    let notes = json!({"notes": "I work on agent evaluation."});
    let (status, body) = send(&app, "POST", BUILD, &token, Some(notes.clone())).await;
    assert_eq!(status, 202, "{body}");

    // The run is cancelled elsewhere (stopped, lost, declined) without telling the card.
    let run_id: String =
        query_scalar("SELECT active_run_id FROM cloud_common_ground_cards WHERE account_id = $1")
            .bind(&alex)
            .fetch_one(&pool)
            .await
            .unwrap();
    query("UPDATE cloud_agent_fallback_runs SET status = 'cancelled' WHERE run_id = $1")
        .bind(&run_id)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = send(&app, "GET", CARD, &token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (&body["build"]["status"], &body["build"]["errorCode"]),
        (&Value::from("failed"), &Value::from("build_interrupted")),
        "{body}"
    );

    // A new build starts over it.
    let (status, body) = send(&app, "POST", BUILD, &token, Some(notes)).await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["build"]["status"], "building", "{body}");

    // A run still queued past the in-flight window timed out.
    query(
        "UPDATE cloud_common_ground_cards SET build_started_at = now() - interval '20 minutes'
         WHERE account_id = $1",
    )
    .bind(&alex)
    .execute(&pool)
    .await
    .unwrap();
    let (status, body) = send(&app, "GET", CARD, &token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (&body["build"]["status"], &body["build"]["errorCode"]),
        (&Value::from("failed"), &Value::from("build_timed_out")),
        "{body}"
    );
}
