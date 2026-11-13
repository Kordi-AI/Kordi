//! Who is matched again after a card changes: only people with a stored
//! match who are still linked live by the visibility rules, and only when a
//! run may be queued now.

use serde_json::json;
use sqlx_core::query::query;

use super::db_fixture::{pool, send, signed_in};
use super::rematch_support::{
    limiter, look_again_now, mark, match_room, match_runs, open_cards, open_match, pair,
    profile_of, tick, CG,
};
use super::support::{
    answer_match, build_card_with, card_reply, join_fresh_room, people_in_a_room,
};
use crate::common_ground::MATCH_LIMIT;

fn changed_card() -> String {
    card_reply(&["Agent memory", "Evals"], &["Retrieval"], &[], &[])
}

fn plain_card() -> String {
    card_reply(&["Agent memory"], &["Retrieval"], &[], &[])
}

#[tokio::test]
async fn people_no_longer_linked_or_never_matched_are_left_out() {
    let Some(pool) = pool().await else {
        return;
    };
    let labels = ["Ada", "Ben", "Cy", "Dee", "Eve", "Fay"];
    let (app, code, people) = people_in_a_room(&pool, &labels).await;
    let [ada, ben, cy, dee, eve, fay] = std::array::from_fn(|i| people[i].clone());
    let mut extra = Vec::new();
    for label in ["Gus", "Hal", "Ivy"] {
        let (id, token) = signed_in(&pool, label).await;
        build_card_with(&app, &pool, &id, &token, &plain_card()).await;
        extra.push((id, token));
    }
    let [gus, hal, ivy] = std::array::from_fn(|i| extra[i].clone());
    let mut profiles = Vec::new();
    for (account, _) in people.iter().chain(&extra) {
        profiles.push(profile_of(&pool, account).await);
    }
    let all: Vec<&str> = profiles.iter().map(String::as_str).collect();
    let mine = profiles[0].clone();
    let limiter = limiter();
    tick(&pool, &limiter, &all).await;

    match_room(&app, &pool, &code, &ada.0, &ada.1).await;
    // Hal is paired, and his match was opened.
    pair(&app, &ada.1, &hal.1).await;
    open_match(&app, &pool, (&ada.0, &ada.1), &hal.0).await;
    // Ivy shares only a room that has closed since.
    let other_room = join_fresh_room(&app, &pool, &[&ada.1, &ivy.1]).await;
    match_room(&app, &pool, &other_room, &ada.0, &ada.1).await;
    query("UPDATE cloud_common_ground_rooms SET closed_at = now() WHERE code = $1 AND closed_at IS NULL")
        .bind(&other_room)
        .execute(&pool)
        .await
        .unwrap();
    // Gus joins after the matching: no stored match yet.
    let join = format!("{CG}/rooms/{code}/join");
    assert_eq!(send(&app, "POST", &join, &gus.1, None).await.0, 200);
    // Ben leaves, Cy stops sharing, Dee blocks Ada, Eve hides her card.
    let leave = format!("{CG}/rooms/{code}/leave");
    assert_eq!(send(&app, "POST", &leave, &ben.1, None).await.0, 204);
    let off = json!({"sharing": false});
    let settings = format!("{CG}/settings");
    assert_eq!(send(&app, "PUT", &settings, &cy.1, Some(off)).await.0, 200);
    query(
        "INSERT INTO cloud_account_blocks(blocker_account_id, blocked_account_id) VALUES ($1, $2)",
    )
    .bind(&dee.0)
    .bind(&ada.0)
    .execute(&pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_contact_permissions(owner_account_id, subject_account_id, card_access)
         VALUES ($1, $2, false)",
    )
    .bind(&eve.0)
    .bind(&ada.0)
    .execute(&pool)
    .await
    .unwrap();
    tick(&pool, &limiter, &all).await;

    build_card_with(&app, &pool, &ada.0, &ada.1, &changed_card()).await;
    let runs = match_runs(&pool, &ada.0).await;
    tick(&pool, &limiter, &[&mine]).await;
    assert_eq!(match_runs(&pool, &ada.0).await, runs + 1);
    assert_eq!(mark(&pool, &mine).await, None);
    assert_eq!(open_cards(&pool, &ada.0).await, [ada.0, hal.0, fay.0]);
}

#[tokio::test]
async fn a_run_at_work_keeps_the_mark_until_it_finishes() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _code, people) = people_in_a_room(&pool, &["Ada", "Ben", "Cy"]).await;
    let [ada, ben, cy] = std::array::from_fn(|i| people[i].clone());
    let mut profiles = Vec::new();
    for (account, _) in &people {
        profiles.push(profile_of(&pool, account).await);
    }
    let all: Vec<&str> = profiles.iter().map(String::as_str).collect();
    let mine = profiles[0].clone();
    let limiter = limiter();
    tick(&pool, &limiter, &all).await;
    // Only Ben has a stored match with Ada.
    open_match(&app, &pool, (&ada.0, &ada.1), &ben.0).await;
    build_card_with(&app, &pool, &ada.0, &ada.1, &changed_card()).await;
    // Ada opens Cy's match: a run for her profile is at work.
    let detail = format!("{CG}/people/{}/match", cy.0);
    assert_eq!(send(&app, "GET", &detail, &ada.1, None).await.0, 202);
    let runs = match_runs(&pool, &ada.0).await;
    tick(&pool, &limiter, &[&mine]).await;
    assert_eq!(match_runs(&pool, &ada.0).await, runs, "nothing new queued");
    assert!(mark(&pool, &mine).await.is_some(), "the mark stays");
    assert_eq!(open_cards(&pool, &ada.0).await, [ada.0.clone(), cy.0]);

    answer_match(&pool, &ada.0).await;
    look_again_now(&pool, &mine).await;
    tick(&pool, &limiter, &[&mine]).await;
    assert_eq!(match_runs(&pool, &ada.0).await, runs + 1);
    assert_eq!(mark(&pool, &mine).await, None);
    assert_eq!(open_cards(&pool, &ada.0).await, [ada.0, ben.0]);
}

#[tokio::test]
async fn declined_ai_or_a_spent_budget_queue_nothing_and_clear_the_mark() {
    let Some(pool) = pool().await else {
        return;
    };
    let limiter = limiter();
    for spent_budget in [false, true] {
        let (app, code, people) = people_in_a_room(&pool, &["Ada", "Ben"]).await;
        let [ada, ben] = std::array::from_fn(|i| people[i].clone());
        let (mine, bens) = (
            profile_of(&pool, &ada.0).await,
            profile_of(&pool, &ben.0).await,
        );
        tick(&pool, &limiter, &[&mine, &bens]).await;
        match_room(&app, &pool, &code, &ada.0, &ada.1).await;
        build_card_with(&app, &pool, &ada.0, &ada.1, &changed_card()).await;
        if spent_budget {
            for _ in 0..MATCH_LIMIT.limit {
                let _ = limiter.observe_account_limit(MATCH_LIMIT, &ada.0).await;
            }
        } else {
            query("UPDATE cloud_accounts SET ai_consent_status = 'declined' WHERE account_id = $1")
                .bind(&ada.0)
                .execute(&pool)
                .await
                .unwrap();
        }
        let runs = match_runs(&pool, &ada.0).await;
        tick(&pool, &limiter, &[&mine]).await;
        assert_eq!(
            match_runs(&pool, &ada.0).await,
            runs,
            "spent: {spent_budget}"
        );
        assert_eq!(mark(&pool, &mine).await, None, "spent: {spent_budget}");
    }
}
