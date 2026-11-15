//! A room's background runs list topic labels only; opening a person they
//! matched runs that pair in full, ahead of the queue.

use serde_json::json;
use sqlx_core::query_as::query_as;

use super::db_fixture::send;
use super::support::{answer_match, answer_themes, claim_open, people_in_a_room, RUNNER};
use crate::common_ground::complete;

const CG: &str = "/v1/cloud/common-ground";

/// The prompt instructions and lease head start of a queued run.
async fn queued(pool: &sqlx_postgres::PgPool, run_id: &str) -> (String, i32) {
    query_as(
        "SELECT system_prompt, lease_head_start_seconds FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn background_runs_are_brief_and_opening_runs_the_pair_in_full() {
    let Some(pool) = super::db_fixture::pool().await else {
        return;
    };
    let labels = ["Ada", "Ben", "Cy", "Dee", "Eve", "Fay", "Gus", "Hal"];
    let (app, code, people) = people_in_a_room(&pool, &labels).await;
    let results = format!("{CG}/rooms/{code}/results");
    let (ada, token) = &people[0];
    send(&app, "POST", &results, token, None).await;
    answer_themes(&pool, &[]).await;
    let best = answer_match(&pool, ada).await;
    assert!(
        !best.starts_with("cg_match_brief_"),
        "the best five run in full"
    );

    // The other two follow in a brief run: labels only, no reasons asked for.
    send(&app, "POST", &results, token, None).await;
    let (run_id, cards) = claim_open(&pool, "match", Some(ada)).await;
    assert!(run_id.starts_with("cg_match_brief_"), "{run_id}");
    let (system_prompt, _) = queued(&pool, &run_id).await;
    assert!(
        system_prompt.contains("Write no reasons"),
        "{system_prompt}"
    );
    let gus = cards[1].clone();
    let reply = json!({"people": [
        {"person": 0, "shared": [{"mine": "Agent memory", "theirs": "Agent memory"}]},
        {"person": 1, "shared": [{"mine": "Agent memory", "theirs": "Agent memory"}]}
    ]});
    complete(&pool, &run_id, RUNNER, &reply.to_string())
        .await
        .unwrap();
    let (status, body) = send(&app, "POST", &results, token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "ready", "{body}");
    let row = body["people"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["person"]["accountId"] == json!(gus))
        .unwrap()
        .clone();
    assert!(
        row.get("estimated").is_none(),
        "a brief result is a model result"
    );
    assert!(row["score"].as_i64().unwrap() > 0);
    assert!(row.get("brief").is_none());

    // Opening Gus shows the brief score and topics at once and runs the pair
    // in full, with the opened run's head start.
    let detail = format!("{CG}/people/{gus}/match");
    let (status, body) = send(&app, "GET", &detail, token, None).await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["estimated"], true);
    assert_eq!(body["score"], row["score"]);
    assert_eq!(body["shared"][0]["topic"], "Agent memory");
    assert_eq!(body["shared"][0]["why"], "");
    assert!(body.get("brief").is_none());
    let (full, cards) = claim_open(&pool, "match", Some(ada)).await;
    assert!(!full.starts_with("cg_match_brief_"), "{full}");
    assert_eq!(cards, vec![ada.clone(), gus.clone()]);
    let (system_prompt, head_start) = queued(&pool, &full).await;
    assert!(!system_prompt.contains("Write no reasons"));
    assert!(head_start > 0, "an opened run goes ahead");
    let reply = json!({"people": [{"person": 0,
        "shared": [{"mine": "Agent memory", "theirs": "Agent memory", "why": "Both study agent memory"}],
        "next_step": "Compare notes"}]});
    complete(&pool, &full, RUNNER, &reply.to_string())
        .await
        .unwrap();
    let (status, body) = send(&app, "GET", &detail, token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "ready");
    assert!(body.get("estimated").is_none());
    assert_eq!(body["shared"][0]["why"], "Both study agent memory");

    // The brief run stored Gus's side too; the full run replaced it, so Gus
    // sees the reasons without another run.
    let gus_token = &people.iter().find(|(id, _)| *id == gus).unwrap().1;
    let (status, body) = send(
        &app,
        "GET",
        &format!("{CG}/people/{ada}/match"),
        gus_token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["shared"][0]["why"], "Both study agent memory");
}
