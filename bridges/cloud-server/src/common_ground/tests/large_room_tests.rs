//! Large rooms: everyone shows at once by estimate, the model details only
//! each viewer's best few, themes wait while people join, and polling a busy
//! room never starves the database pool.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPoolOptions;

use super::db_fixture::{account, app, pool, send, signed_in};
use super::support::{
    answer_themes, build_card_with, card_reply, claim_open, join_fresh_room, open_runs, RUNNER,
};
use crate::common_ground::complete;

/// Signed-in people with these working-on topics, cards built, and the app
/// with the System agent configured.
async fn people_with(
    pool: &sqlx_postgres::PgPool,
    cards: &[(&str, &str)],
) -> (axum::Router, Vec<(String, String)>) {
    if crate::system_agent::service_account_id().is_none() {
        let candidate = account(pool, "service").await;
        crate::system_agent::SystemAgentService::new(crate::system_agent::test_config(&candidate));
    }
    let service = crate::system_agent::service_account_id()
        .unwrap()
        .to_string();
    let app = app(pool, Some(&service));
    let mut people = Vec::new();
    for (label, topic) in cards {
        let (id, token) = signed_in(pool, label).await;
        build_card_with(
            &app,
            pool,
            &id,
            &token,
            &card_reply(&[topic], &[], &[], &[]),
        )
        .await;
        people.push((id, token));
    }
    (app, people)
}

fn ids(body: &Value) -> Vec<String> {
    body["people"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["person"]["accountId"].as_str().unwrap().to_string())
        .collect()
}

fn estimated(body: &Value) -> usize {
    body["people"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["estimated"] == json!(true))
        .count()
}

#[tokio::test]
async fn everyone_shows_at_once_and_the_model_details_the_best_few() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, people) = people_with(
        &pool,
        &[
            ("Ada", "Agent memory benchmarks"),
            ("Bo", "agent memory"),
            ("Cy", "Memory benchmarks for agents"),
            ("Di", "Robot grasping"),
            ("Ed", "Protein folding"),
            ("Fay", "Soil science"),
            ("Gus", "Jazz guitar"),
            ("Hal", "Urban transit"),
        ],
    )
    .await;
    let tokens: Vec<&str> = people.iter().map(|(_, t)| t.as_str()).collect();
    let code = join_fresh_room(&app, &pool, &tokens).await;
    let results = format!("/v1/cloud/common-ground/rooms/{code}/results");
    let (ada, ada_token) = &people[0];

    let (status, body) = send(&app, "POST", &results, ada_token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "matching");
    let shown = ids(&body);
    assert_eq!(shown.len(), 7, "everyone else shows at once");
    assert_eq!(estimated(&body), 7);
    let closest: Vec<&String> = vec![&people[1].0, &people[2].0];
    assert!(
        closest.contains(&&shown[0]) && closest.contains(&&shown[1]),
        "{body}"
    );
    assert!(body["people"][0]["headline"].as_str().is_some());

    // One run for the best five by estimate; polling queues nothing more.
    let (status, _) = send(&app, "POST", &results, ada_token, None).await;
    assert_eq!(status, 200);
    assert_eq!(
        open_runs(&pool, ada).await,
        2,
        "one match run and one theme run"
    );
    // A run that waits behind a busy room for a while still blocks another.
    query(
        "UPDATE cloud_common_ground_match_runs SET created_at = now() - interval '20 minutes'
         WHERE viewer_account_id = $1",
    )
    .bind(ada)
    .execute(&pool)
    .await
    .unwrap();
    let (status, _) = send(&app, "POST", &results, ada_token, None).await;
    assert_eq!(status, 200);
    assert_eq!(
        open_runs(&pool, ada).await,
        2,
        "no second run while one waits"
    );
    let (run_id, cards) = claim_open(&pool, "match", Some(ada)).await;
    assert_eq!(cards.len(), 1 + 5);
    assert_eq!(&cards[0], ada);
    assert!(cards.contains(&people[1].0) && cards.contains(&people[2].0));
    let reply = json!({"people": [
        {"person": cards[1..].iter().position(|c| c == &people[1].0).unwrap(),
         "shared": [{"mine": "Agent memory benchmarks", "theirs": "agent memory", "why": "Both study agent memory"}],
         "next_step": "Compare memory benchmarks"}
    ]});
    complete(&pool, &run_id, RUNNER, &reply.to_string())
        .await
        .unwrap();
    answer_themes(&pool, &[]).await;

    let (status, body) = send(&app, "POST", &results, ada_token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "ready", "{body}");
    assert_eq!(ids(&body).len(), 7);
    assert_eq!(estimated(&body), 2, "the model replaced the best five");
    assert_eq!(body["people"][0]["person"]["accountId"], json!(people[1].0));
    assert!(body["people"][0].get("estimated").is_none());
    assert_eq!(
        open_runs(&pool, ada).await,
        0,
        "nobody else is matched until opened"
    );

    // Opening someone outside the best five queues one run for that pair
    // and shows the estimated topics at once.
    let rest: Vec<&String> = shown.iter().filter(|id| !cards.contains(id)).collect();
    assert_eq!(rest.len(), 2);
    let (status, body) = send(
        &app,
        "GET",
        &format!("/v1/cloud/common-ground/people/{}/match", rest[0]),
        ada_token,
        None,
    )
    .await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["status"], "matching");
    assert_eq!(body["estimated"], true);
    assert!(
        body["shared"].is_array() && body["nextStep"] == "",
        "{body}"
    );
    let (_, cards) = claim_open(&pool, "match", Some(ada)).await;
    assert_eq!(cards, vec![ada.clone(), rest[0].clone()]);
}

#[tokio::test]
async fn themes_wait_while_people_join() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, people) = people_with(
        &pool,
        &[
            ("Ada", "Agent memory"),
            ("Bo", "Agent memory"),
            ("Cy", "Agent memory"),
            ("Di", "Agent memory"),
        ],
    )
    .await;
    let code = join_fresh_room(&app, &pool, &[&people[0].1, &people[1].1, &people[2].1]).await;
    let results = format!("/v1/cloud/common-ground/rooms/{code}/results");
    send(&app, "POST", &results, &people[0].1, None).await;
    let members = [&people[0].0, &people[1].0, &people[2].0];
    answer_themes(&pool, &[("Agent memory", &members)]).await;

    // A fourth person joins moments later: the themes stay, none re-run.
    let (status, _) = send(
        &app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/join"),
        &people[3].1,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let (status, body) = send(&app, "POST", &results, &people[3].1, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["topics"][0]["label"], "Agent memory");
    let (themes,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_common_ground_match_runs m
         JOIN cloud_common_ground_rooms r ON r.room_id = m.room_id
         WHERE m.kind = 'room' AND r.code = $1 AND m.finished_at IS NULL",
    )
    .bind(&code)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(themes, 0, "no theme run per join");

    // Once the stored themes are old enough, the next request runs them again.
    query(
        "UPDATE cloud_common_ground_room_themes t SET computed_at = now() - interval '3 minutes'
         FROM cloud_common_ground_rooms r WHERE r.room_id = t.room_id AND r.code = $1",
    )
    .bind(&code)
    .execute(&pool)
    .await
    .unwrap();
    send(&app, "POST", &results, &people[3].1, None).await;
    let (_, read) = claim_open(&pool, "room", None).await;
    assert_eq!(read.len(), 4, "the new theme run reads everyone");
}

#[tokio::test]
async fn polling_a_busy_room_waits_for_one_connection_at_a_time() {
    let Some(setup) = pool().await else {
        return;
    };
    let labels: Vec<(String, &str)> = (0..8).map(|i| (format!("P{i}"), "Agent memory")).collect();
    let cards: Vec<(&str, &str)> = labels.iter().map(|(l, t)| (l.as_str(), *t)).collect();
    let (_, people) = people_with(&setup, &cards).await;
    let tokens: Vec<&str> = people.iter().map(|(_, t)| t.as_str()).collect();
    let service = crate::system_agent::service_account_id()
        .unwrap()
        .to_string();
    let code = join_fresh_room(&app(&setup, Some(&service)), &setup, &tokens).await;

    // A pool this small deadlocked when a request held the room lock in one
    // connection and waited for a second one.
    let url = std::env::var("DATABASE_URL").unwrap();
    let small = PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(std::time::Duration::from_secs(15))
        .connect(&url)
        .await
        .unwrap();
    let app = app(&small, Some(&service));
    let results = format!("/v1/cloud/common-ground/rooms/{code}/results");
    let mut polls = tokio::task::JoinSet::new();
    for _ in 0..3 {
        for token in &tokens {
            let (app, results, token) = (app.clone(), results.clone(), token.to_string());
            polls.spawn(async move { send(&app, "POST", &results, &token, None).await });
        }
    }
    while let Some(poll) = polls.join_next().await {
        let (status, body) = poll.unwrap();
        assert_eq!(status, 200, "{body}");
    }
    let (runs,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_common_ground_match_runs m
         JOIN cloud_common_ground_rooms r ON r.room_id = m.room_id
         WHERE m.kind = 'match' AND r.code = $1",
    )
    .bind(&code)
    .fetch_one(&setup)
    .await
    .unwrap();
    assert!(
        (1..=8).contains(&runs),
        "at most one run per viewer: {runs}"
    );
}
