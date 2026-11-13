//! Each pair runs once: a finding that reads the same to either person is
//! stored for both, a pair already being matched is not queued again, and
//! room members hear about every change to their results.

use serde_json::json;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::db_fixture::{account, app, pool, send, signed_in};
use super::support::{build_card_with, card_reply, claim_open, join_fresh_room, RUNNER};
use crate::common_ground::{card, complete, fail, matching};

const CG: &str = "/v1/cloud/common-ground";

async fn hints(pool: &PgPool, account: &str, event_type: &str) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_chat_user_sync_events WHERE account_id = $1 AND event_type = $2",
    )
    .bind(account)
    .bind(event_type)
    .fetch_one(pool)
    .await
    .unwrap();
    count
}

async fn room_hints(pool: &PgPool, account: &str) -> i64 {
    hints(pool, account, "common_ground.room.updated").await
}

/// Match runs ever queued for this viewer.
async fn match_runs(pool: &PgPool, viewer: &str) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_common_ground_match_runs WHERE kind = 'match' AND viewer_account_id = $1",
    )
    .bind(viewer)
    .fetch_one(pool)
    .await
    .unwrap();
    count
}

/// Stored matches with this account as the viewer.
async fn rows_for(pool: &PgPool, viewer: &str) -> i64 {
    let (count,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_common_ground_matches WHERE viewer_account_id = $1")
            .bind(viewer)
            .fetch_one(pool)
            .await
            .unwrap();
    count
}

/// Alex and Priya, whose cards complement each other, in a fresh room.
async fn alex_and_priya(
    pool: &PgPool,
) -> (axum::Router, String, (String, String), (String, String)) {
    let service = account(pool, "service").await;
    let app = app(pool, Some(&service));
    let alex = signed_in(pool, "Alex").await;
    let priya = signed_in(pool, "Priya").await;
    let alex_card = card_reply(
        &["Agent memory"],
        &["Retrieval"],
        &["Eval design"],
        &["GPU access"],
    );
    build_card_with(&app, pool, &alex.0, &alex.1, &alex_card).await;
    let priya_card = card_reply(
        &["Memory for agents"],
        &["Retrieval"],
        &["GPU clusters"],
        &["Eval design help"],
    );
    build_card_with(&app, pool, &priya.0, &priya.1, &priya_card).await;
    let code = join_fresh_room(&app, pool, &[&alex.1, &priya.1]).await;
    (app, code, alex, priya)
}

/// Answers Alex's open match run about Priya, with `they_why` as the reason
/// for what Priya brings.
async fn answer_alex(pool: &PgPool, alex: &str, they_why: &str) {
    let (run_id, _) = claim_open(pool, "match", Some(alex)).await;
    let reply = json!({"people": [{
        "person": 0,
        "shared": [
            {"mine": "Agent memory", "theirs": "Memory for agents", "why": "Both study memory for agents"},
            {"mine": "Retrieval", "theirs": "Retrieval", "why": "Both care about retrieval"}],
        "you_bring": [{"topic": "Eval design", "for": "Eval design help", "why": "Eval experience meets the eval need"}],
        "they_bring": [{"topic": "GPU clusters", "for": "GPU access", "why": they_why}],
        "next_step": "Compare memory benchmarks over coffee"}]});
    complete(pool, &run_id, RUNNER, &reply.to_string())
        .await
        .unwrap();
}

/// Answers the room's open theme run, so results are not waiting on it.
async fn answer_themes(pool: &PgPool) {
    let (run_id, members) = claim_open(pool, "room", None).await;
    let themes = json!({"themes": [{"label": "Agent memory", "people": (0..members.len()).collect::<Vec<_>>()}]});
    complete(pool, &run_id, RUNNER, &themes.to_string())
        .await
        .unwrap();
}

#[tokio::test]
async fn one_run_stores_a_neutral_pair_for_both_people() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, (alex, alex_token), (priya, priya_token)) = alex_and_priya(&pool).await;
    let results = format!("{CG}/rooms/{code}/results");

    // The first request tells every member that matching started, once.
    let before = room_hints(&pool, &priya).await;
    let (status, body) = send(&app, "POST", &results, &alex_token, None).await;
    assert_eq!((status, body["status"].as_str()), (200, Some("matching")));
    send(&app, "POST", &results, &alex_token, None).await;
    assert_eq!(room_hints(&pool, &priya).await, before + 1);

    let waiting = hints(&pool, &priya, "common_ground.matches.updated").await;
    answer_alex(&pool, &alex, "Cluster time covers the compute need").await;
    answer_themes(&pool).await;
    assert_eq!(
        hints(&pool, &priya, "common_ground.matches.updated").await,
        waiting + 1,
        "priya hears that her side was stored"
    );

    // Priya's first request is ready from Alex's run and queues nothing.
    let (status, body) = send(&app, "POST", &results, &priya_token, None).await;
    assert_eq!(
        (status, body["status"].as_str()),
        (200, Some("ready")),
        "{body}"
    );
    assert_eq!(body["people"][0]["person"]["accountId"], alex.as_str());
    assert_eq!(match_runs(&pool, &priya).await, 0);
    let (_, recent) = send(&app, "GET", &format!("{CG}/recent"), &priya_token, None).await;
    assert_eq!(recent["people"], json!([]), "a match she never opened");

    let (_, mine) = send(
        &app,
        "GET",
        &format!("{CG}/people/{priya}/match"),
        &alex_token,
        None,
    )
    .await;
    let (status, theirs) = send(
        &app,
        "GET",
        &format!("{CG}/people/{alex}/match"),
        &priya_token,
        None,
    )
    .await;
    assert_eq!(
        (status, &theirs["status"]),
        (200, &json!("ready")),
        "{theirs}"
    );
    assert_eq!(theirs["youBring"], mine["theyBring"]);
    assert_eq!(theirs["theyBring"], mine["youBring"]);
    assert_eq!(
        theirs["shared"][0],
        json!({"topic": "Memory for agents", "theirTopic": "Agent memory", "why": "Both study memory for agents"})
    );
    assert_eq!(theirs["nextStep"], mine["nextStep"]);
    assert_eq!(
        (mine["headline"].as_str(), theirs["headline"].as_str()),
        (Some("Memory for agents"), Some("Agent memory")),
        "each side is headlined with the other person's topic"
    );
    assert!(theirs["score"].as_i64().unwrap() > 50, "{theirs}");
}

#[tokio::test]
async fn a_reply_that_addresses_the_viewer_is_stored_for_the_viewer_only() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, (alex, alex_token), (priya, priya_token)) = alex_and_priya(&pool).await;
    let results = format!("{CG}/rooms/{code}/results");
    send(&app, "POST", &results, &alex_token, None).await;
    answer_alex(&pool, &alex, "You need compute").await;
    answer_themes(&pool).await;
    assert_eq!(
        (rows_for(&pool, &alex).await, rows_for(&pool, &priya).await),
        (1, 0)
    );
    let (status, body) = send(&app, "POST", &results, &priya_token, None).await;
    assert_eq!(
        (status, body["status"].as_str()),
        (200, Some("matching")),
        "{body}"
    );
    let (_, cards) = claim_open(&pool, "match", Some(&priya)).await;
    assert_eq!(cards, vec![priya.clone(), alex.clone()], "her own run");
}

#[tokio::test]
async fn a_viewer_who_has_not_allowed_ai_gets_no_rows_written_about_them() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, (alex, alex_token), (priya, priya_token)) = alex_and_priya(&pool).await;
    query("UPDATE cloud_accounts SET ai_consent_status = 'unset' WHERE account_id = $1")
        .bind(&alex)
        .execute(&pool)
        .await
        .unwrap();
    let results = format!("{CG}/rooms/{code}/results");
    let (status, body) = send(&app, "POST", &results, &alex_token, None).await;
    assert_eq!((status, body["status"].as_str()), (200, Some("matching")));
    answer_alex(&pool, &alex, "Cluster time covers the compute need").await;
    assert_eq!(
        (rows_for(&pool, &alex).await, rows_for(&pool, &priya).await),
        (1, 0),
        "alex asked, so his own match is stored; nothing about him for priya"
    );
    let (_, body) = send(&app, "POST", &results, &priya_token, None).await;
    assert_eq!(body["people"], json!([]), "{body}");
    assert_eq!(match_runs(&pool, &priya).await, 0, "his card is not sent");
}

#[tokio::test]
async fn a_pair_already_being_matched_is_not_queued_again() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let mut people = Vec::new();
    for label in ["Alex", "Priya", "Sam"] {
        let (id, token) = signed_in(&pool, label).await;
        let reply = card_reply(&["Agent memory"], &["Retrieval"], &[], &[]);
        build_card_with(&app, &pool, &id, &token, &reply).await;
        people.push((id, token));
    }
    let [(alex, alex_token), (priya, priya_token), (sam, sam_token)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    let code = join_fresh_room(&app, &pool, &[&alex_token, &priya_token, &sam_token]).await;
    let results = format!("{CG}/rooms/{code}/results");
    send(&app, "POST", &results, &alex_token, None).await;
    let (alex_run, alex_cards) = claim_open(&pool, "match", Some(&alex)).await;
    assert_eq!(alex_cards.len(), 3);

    // Alex's run covers Priya: only Sam is left to queue for her.
    let (_, body) = send(&app, "POST", &results, &priya_token, None).await;
    assert_eq!(body["status"], "matching");
    let (priya_run, priya_cards) = claim_open(&pool, "match", Some(&priya)).await;
    assert_eq!(priya_cards, vec![priya.clone(), sam.clone()]);

    // Both runs cover Sam: he waits, and waiting is free. More polls than
    // the hourly budget of 60 queued runs.
    for _ in 0..70 {
        let (status, body) = send(&app, "POST", &results, &sam_token, None).await;
        assert_eq!(
            (status, body["status"].as_str()),
            (200, Some("matching")),
            "{body}"
        );
    }
    assert_eq!(match_runs(&pool, &sam).await, 0);

    // Once those runs fail, Sam queues his own, still within budget.
    for run in [alex_run, priya_run] {
        fail(&pool, &run, Some(RUNNER), "provider_error")
            .await
            .unwrap();
    }
    let (status, body) = send(&app, "POST", &results, &sam_token, None).await;
    assert_eq!((status, body["status"].as_str()), (200, Some("matching")));
    let (_, sam_cards) = claim_open(&pool, "match", Some(&sam)).await;
    assert_eq!(sam_cards, vec![sam.clone(), alex.clone(), priya.clone()]);
}

#[tokio::test]
async fn members_asking_at_once_queue_a_pair_once() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, (alex, alex_token), (priya, priya_token)) = alex_and_priya(&pool).await;
    let results = format!("{CG}/rooms/{code}/results");
    let before = (
        room_hints(&pool, &alex).await,
        room_hints(&pool, &priya).await,
    );
    let (first, second) = tokio::join!(
        send(&app, "POST", &results, &alex_token, None),
        send(&app, "POST", &results, &priya_token, None),
    );
    assert_eq!((first.0, second.0), (200, 200));
    assert_eq!(
        match_runs(&pool, &alex).await + match_runs(&pool, &priya).await,
        1
    );
    assert_eq!(
        (
            room_hints(&pool, &alex).await,
            room_hints(&pool, &priya).await
        ),
        (before.0 + 1, before.1 + 1),
        "one hint per member that matching started"
    );
}

#[tokio::test]
async fn card_changes_tell_the_rooms_the_card_is_in() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _code, (alex, alex_token), (priya, _)) = alex_and_priya(&pool).await;
    let mut expected = room_hints(&pool, &priya).await;
    let mut check = |changed: bool, step: &str| {
        expected += i64::from(changed);
        let pool = pool.clone();
        let priya = priya.clone();
        let want = expected;
        let step = step.to_string();
        async move { assert_eq!(room_hints(&pool, &priya).await, want, "{step}") }
    };

    let reply = card_reply(&["Agent memory", "Evals"], &["Retrieval"], &[], &[]);
    build_card_with(&app, &pool, &alex, &alex_token, &reply).await;
    check(true, "a rebuild").await;
    let topics = json!({"workingOn": ["Agent memory"], "interests": ["Retrieval"], "canHelp": [], "lookingFor": []});
    let (status, _) = send(
        &app,
        "PUT",
        &format!("{CG}/card"),
        &alex_token,
        Some(topics),
    )
    .await;
    assert_eq!(status, 200);
    check(true, "a topic edit").await;
    let hidden = json!({"hidden": ["Retrieval"]});
    let (status, _) = send(
        &app,
        "PUT",
        &format!("{CG}/card/hidden"),
        &alex_token,
        Some(hidden),
    )
    .await;
    assert_eq!(status, 200);
    check(true, "hidden topics").await;
    let settings = format!("{CG}/settings");
    let (status, _) = send(
        &app,
        "PUT",
        &settings,
        &alex_token,
        Some(json!({"autoRebuild": true})),
    )
    .await;
    assert_eq!(status, 200);
    check(false, "the automatic setting changes nothing others see").await;
    let (status, _) = send(
        &app,
        "PUT",
        &settings,
        &alex_token,
        Some(json!({"sharing": false})),
    )
    .await;
    assert_eq!(status, 200);
    check(true, "sharing off").await;
    let (status, _) = send(
        &app,
        "PUT",
        &settings,
        &alex_token,
        Some(json!({"sharing": true})),
    )
    .await;
    assert_eq!(status, 200);
    check(true, "sharing on").await;
}

#[tokio::test]
async fn shared_cards_load_a_mixed_room_in_order() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let mut people = Vec::new();
    for label in ["Alex", "Priya", "Sam"] {
        let (id, token) = signed_in(&pool, label).await;
        let reply = card_reply(&["Agent memory", "Evals"], &["Retrieval"], &["Python"], &[]);
        build_card_with(&app, &pool, &id, &token, &reply).await;
        people.push((id, token));
    }
    let (_, no_card) = signed_in(&pool, "Lee").await;
    let [(alex, alex_token), (priya, priya_token), (sam, _)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    let hidden = json!({"hidden": ["Evals", "Python"]});
    send(
        &app,
        "PUT",
        &format!("{CG}/card/hidden"),
        &alex_token,
        Some(hidden),
    )
    .await;
    send(
        &app,
        "PUT",
        &format!("{CG}/settings"),
        &priya_token,
        Some(json!({"sharing": false})),
    )
    .await;
    let profile = |account: String| {
        let pool = pool.clone();
        async move {
            let (id,): (String,) = query_as(
                "SELECT profile_id FROM cloud_common_ground_profiles WHERE account_id = $1",
            )
            .bind(&account)
            .fetch_one(&pool)
            .await
            .unwrap();
            (account, id)
        }
    };
    let (sam_pair, alex_pair, priya_pair) = (
        profile(sam).await,
        profile(alex.clone()).await,
        profile(priya).await,
    );
    // Someone else's profile under Alex's account never loads.
    let members = vec![
        sam_pair.clone(),
        priya_pair,
        (no_card, "cgp_missing".to_string()),
        (alex.clone(), sam_pair.1.clone()),
        alex_pair.clone(),
    ];
    let cards = matching::shared_cards(&pool, &members).await.unwrap();
    let loaded: Vec<(&str, &str)> = cards
        .iter()
        .map(|c| (c.account_id.as_str(), c.profile_id.as_str()))
        .collect();
    assert_eq!(
        loaded,
        [
            (sam_pair.0.as_str(), sam_pair.1.as_str()),
            (alex_pair.0.as_str(), alex_pair.1.as_str())
        ]
    );
    for shared in &cards {
        let row = card::load(&pool, &shared.profile_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (&shared.topics, shared.revision),
            (&row.shared_topics(), row.revision)
        );
        assert_eq!(
            (shared.profile_kind.as_str(), shared.profile_name.as_str()),
            ("work", "Work")
        );
    }
    assert_eq!(cards[1].name, "Alex");
    assert_eq!(
        (
            cards[1].topics.working_on.clone(),
            cards[1].topics.can_help.clone()
        ),
        (vec!["Agent memory".to_string()], Vec::<String>::new()),
        "hidden topics are left out"
    );
    assert!(matching::shared_cards(&pool, &[]).await.unwrap().is_empty());
}
