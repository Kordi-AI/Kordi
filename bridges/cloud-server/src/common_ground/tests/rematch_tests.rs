//! Matching again after a card changes: a manual build or an automatic
//! update that changes the card queues one match run for the people it
//! already had a match with and is still linked to, most recently opened
//! first, at most eight. Edits, hides and sharing changes do not.

use serde_json::json;
use sqlx_core::query::query;

use super::auto_rebuild_tests::{claim_auto, due_now, sweep_card, SETTINGS};
use super::db_fixture::{pool, send};
use super::profile_memories_tests::{own, save};
use super::rematch_support::{
    limiter, mark, match_room, match_runs, open_cards, open_match, profile_of, stored, tick, CG,
};
use super::support::{answer_match, build_card_with, card_reply, people_in_a_room, RUNNER};
use crate::common_ground::auto::Outcome;
use crate::common_ground::complete;

/// A card reply other than the one `people_in_a_room` builds.
fn changed_card() -> String {
    card_reply(&["Agent memory", "Evals"], &["Retrieval"], &[], &[])
}

#[tokio::test]
async fn a_manual_build_matches_linked_people_again_in_one_run() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Ada", "Ben", "Cy"]).await;
    let [(ada, ada_token), (ben, _), (cy, _)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    let (mine, bens, cys) = (
        profile_of(&pool, &ada).await,
        profile_of(&pool, &ben).await,
        profile_of(&pool, &cy).await,
    );
    let limiter = limiter();
    // The first builds marked every card; with no match yet nothing runs.
    assert!(mark(&pool, &mine).await.is_some());
    tick(&pool, &limiter, &[&mine, &bens, &cys]).await;
    assert_eq!(mark(&pool, &mine).await, None);
    assert_eq!(match_runs(&pool, &ada).await, 0);

    match_room(&app, &pool, &code, &ada, &ada_token).await;
    open_match(&app, &pool, (&ada, &ada_token), &ben).await;
    let (opened, current) = stored(&pool, &mine, &bens).await;
    assert!(opened.is_some() && current);
    build_card_with(&app, &pool, &ada, &ada_token, &changed_card()).await;
    assert!(mark(&pool, &mine).await.is_some());
    assert!(!stored(&pool, &mine, &bens).await.1);
    assert!(!stored(&pool, &bens, &mine).await.1);

    let runs = match_runs(&pool, &ada).await;
    tick(&pool, &limiter, &[&mine]).await;
    assert_eq!(match_runs(&pool, &ada).await, runs + 1);
    assert_eq!(mark(&pool, &mine).await, None);
    assert_eq!(
        open_cards(&pool, &ada).await,
        [ada.clone(), ben.clone(), cy.clone()],
        "the opened match comes first"
    );
    tick(&pool, &limiter, &[&mine]).await;
    assert_eq!(
        match_runs(&pool, &ada).await,
        runs + 1,
        "one run per change"
    );

    answer_match(&pool, &ada).await;
    for other in [&bens, &cys] {
        assert!(stored(&pool, &mine, other).await.1, "ada's side is current");
        assert!(
            stored(&pool, other, &mine).await.1,
            "and theirs, from the same run"
        );
    }
    assert_eq!(
        stored(&pool, &mine, &bens).await.0,
        opened,
        "opened_at stays"
    );
    let (_, recent) = send(&app, "GET", &format!("{CG}/recent"), &ada_token, None).await;
    assert_eq!(recent["people"][0]["person"]["accountId"], ben.as_str());
    assert!(recent["people"][0]["score"].is_i64(), "{recent}");
}

#[tokio::test]
async fn an_automatic_update_that_changes_the_card_matches_again() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Ada", "Ben"]).await;
    let [(ada, ada_token), (ben, _)] = [people[0].clone(), people[1].clone()];
    let (mine, bens) = (profile_of(&pool, &ada).await, profile_of(&pool, &ben).await);
    let limiter = limiter();
    tick(&pool, &limiter, &[&mine, &bens]).await;
    match_room(&app, &pool, &code, &ada, &ada_token).await;
    open_match(&app, &pool, (&ada, &ada_token), &ben).await;
    let opened = stored(&pool, &mine, &bens).await.0;
    let (status, _) = send(
        &app,
        "PUT",
        SETTINGS,
        &ada_token,
        Some(json!({"autoRebuild": true})),
    )
    .await;
    assert_eq!(status, 200);
    let service = crate::system_agent::service_account_id().unwrap();
    let config = due_now();

    save(
        &app,
        &ada_token,
        own("Reviews retrieval papers", "work_context"),
    )
    .await;
    assert_eq!(
        sweep_card(&pool, service, &mine, &config).await,
        Some(Outcome::Queued)
    );
    let (run_id, _) = claim_auto(&pool, &ada).await;
    assert_eq!(mark(&pool, &mine).await, None, "nothing landed yet");
    let update = json!({"add": [{"list": "can_help", "label": "Paper reviews", "evidence": [0]}]});
    complete(&pool, &run_id, RUNNER, &update.to_string())
        .await
        .unwrap();
    assert!(mark(&pool, &mine).await.is_some());
    let runs = match_runs(&pool, &ada).await;
    tick(&pool, &limiter, &[&mine]).await;
    assert_eq!(match_runs(&pool, &ada).await, runs + 1);
    assert_eq!(open_cards(&pool, &ada).await, [ada.clone(), ben.clone()]);
    answer_match(&pool, &ada).await;
    assert_eq!(stored(&pool, &mine, &bens).await, (opened, true));
    assert!(stored(&pool, &bens, &mine).await.1);

    // An update that changes nothing marks nothing.
    save(
        &app,
        &ada_token,
        own("Started the Atlas benchmark", "work_context"),
    )
    .await;
    assert_eq!(
        sweep_card(&pool, service, &mine, &config).await,
        Some(Outcome::Queued)
    );
    let (run_id, _) = claim_auto(&pool, &ada).await;
    complete(&pool, &run_id, RUNNER, "{}").await.unwrap();
    assert_eq!(mark(&pool, &mine).await, None);
    assert!(stored(&pool, &mine, &bens).await.1);
}

#[tokio::test]
async fn more_than_five_people_get_one_run_with_the_opened_matches_first() {
    let Some(pool) = pool().await else {
        return;
    };
    let labels = [
        "Ada", "Ben", "Cy", "Dee", "Eve", "Fay", "Gus", "Hal", "Ivy", "Jo", "Kim",
    ];
    let (app, code, people) = people_in_a_room(&pool, &labels).await;
    let (ada, ada_token) = people[0].clone();
    let mut profiles = Vec::new();
    for (account, _) in &people {
        profiles.push(profile_of(&pool, account).await);
    }
    let all: Vec<&str> = profiles.iter().map(String::as_str).collect();
    let limiter = limiter();
    tick(&pool, &limiter, &all).await;
    // The room matches Ada's five best estimates (all tie, so by name: Ben
    // to Fay); opening Gus, Hal and Ivy matches each of them too.
    match_room(&app, &pool, &code, &ada, &ada_token).await;
    assert_eq!(match_runs(&pool, &ada).await, 1);
    for index in [6, 7, 8] {
        open_match(&app, &pool, (&ada, &ada_token), &people[index].0).await;
    }
    assert_eq!(match_runs(&pool, &ada).await, 4);
    // Dee and Fay, from the room run, were opened earlier; Fay more recently.
    for (index, at) in [(3, "2026-11-01T09:00:00Z"), (5, "2026-11-02T09:00:00Z")] {
        query(
            "UPDATE cloud_common_ground_matches SET opened_at = $3::timestamptz
             WHERE viewer_profile_id = $1 AND other_profile_id = $2",
        )
        .bind(&profiles[0])
        .bind(&profiles[index])
        .bind(at)
        .execute(&pool)
        .await
        .unwrap();
    }
    build_card_with(&app, &pool, &ada, &ada_token, &changed_card()).await;
    tick(&pool, &limiter, &all).await;
    assert_eq!(match_runs(&pool, &ada).await, 5);
    assert_eq!(mark(&pool, &profiles[0]).await, None);
    let cards = open_cards(&pool, &ada).await;
    assert_eq!(cards.len(), 6, "the viewer and five people");
    assert_eq!(cards[0], ada);
    let mut newest: Vec<&String> = cards[1..4].iter().collect();
    newest.sort();
    let mut opened_now = vec![&people[6].0, &people[7].0, &people[8].0];
    opened_now.sort();
    assert_eq!(newest, opened_now, "the most recently opened first");
    assert_eq!(cards[4..], [people[5].0.clone(), people[3].0.clone()]);
    tick(&pool, &limiter, &all).await;
    assert_eq!(match_runs(&pool, &ada).await, 5, "the other three wait");
}

#[tokio::test]
async fn topic_edits_hides_and_sharing_changes_do_not_mark_the_card() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _code, people) = people_in_a_room(&pool, &["Ada", "Ben"]).await;
    let (ada, ada_token) = people[0].clone();
    let mine = profile_of(&pool, &ada).await;
    tick(&pool, &limiter(), &[&mine]).await;
    let topics = json!({"workingOn": ["Agent memory", "Evals"], "interests": ["Retrieval"], "canHelp": [], "lookingFor": []});
    let edits = [
        ("PUT", format!("{CG}/card"), topics),
        (
            "PUT",
            format!("{CG}/card/hidden"),
            json!({"hidden": ["Evals"]}),
        ),
        ("PUT", SETTINGS.to_string(), json!({"sharing": false})),
        ("PUT", SETTINGS.to_string(), json!({"sharing": true})),
    ];
    for (method, path, body) in edits {
        let (status, reply) = send(&app, method, &path, &ada_token, Some(body)).await;
        assert_eq!(status, 200, "{reply}");
        assert_eq!(mark(&pool, &mine).await, None, "{path}");
    }
}
