//! Database tests for the contact profile route and the `about` line. They
//! use the Common ground fixture and its skip rule: outside CI they return
//! early without `$DATABASE_URL`.

use serde_json::{json, Value};
use sqlx_core::query::query;
use uuid::Uuid;

use crate::common_ground::tests::db_fixture::{app, pool, send, signed_in};

mod fixtures;
mod match_tests;
use fixtures::*;

fn profile_path(account_id: &str) -> String {
    format!("/v1/cloud/contacts/{account_id}/profile")
}

#[tokio::test]
async fn person_contact_shows_presence_counts_and_groups_in_common() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (me, token) = signed_in(&pool, "cp_me").await;
    let (nadia, nadia_token) = signed_in(&pool, "cp_nadia").await;
    let (other, _) = signed_in(&pool, "cp_other").await;
    befriend(&pool, &me, &nadia).await;
    let (status, _) = send(
        &app,
        "PATCH",
        "/v1/cloud/auth/me",
        &nadia_token,
        Some(json!({"about": "Robotics PhD."})),
    )
    .await;
    assert_eq!(status, 200);
    let (status, _) = send(
        &app,
        "POST",
        "/v1/cloud/presence/online",
        &nadia_token,
        None,
    )
    .await;
    assert_eq!(status, 200);

    let direct_id = crate::auth::routes::direct_person_session_id(&me, &nadia);
    let direct = conversation(&pool, "direct", &direct_id, &[&me, &nadia]).await;
    let photo = message(&pool, direct, 1, &me, "").await;
    attach(&pool, photo, &me).await;
    let document_message = message(&pool, direct, 2, &nadia, "Notes").await;
    let document = attach(&pool, document_message, &nadia).await;
    share(&pool, &document, &nadia, false).await;
    message(
        &pool,
        direct,
        3,
        &nadia,
        "See https://example.test/a and http://example.test/b",
    )
    .await;
    message(&pool, direct, 4, &me, "No link here").await;
    let deleted = message(&pool, direct, 5, &me, "https://example.test/deleted").await;
    query("UPDATE cloud_chat_messages SET deleted_at = now() WHERE message_id = $1")
        .bind(deleted)
        .execute(&pool)
        .await
        .unwrap();
    let hidden = message(
        &pool,
        direct,
        6,
        &nadia,
        "https://example.test/hidden-for-me",
    )
    .await;
    query("INSERT INTO cloud_chat_message_visibility (account_id, message_id) VALUES ($1, $2)")
        .bind(&me)
        .bind(hidden)
        .execute(&pool)
        .await
        .unwrap();
    // A revoked share does not count; a link in a group is not in the direct chat.
    let revoked_message = message(&pool, direct, 7, &me, "Old notes").await;
    let revoked = attach(&pool, revoked_message, &me).await;
    share(&pool, &revoked, &me, true).await;

    let space = |label: &str| format!("session:group:{label}-{}", Uuid::new_v4().simple());
    let older = space("older");
    let group = conversation(&pool, "group", &older, &[&me, &nadia, &other]).await;
    message(&pool, group, 1, &nadia, "https://example.test/group").await;
    let newer = space("newer");
    conversation(&pool, "group", &newer, &[&nadia, &me]).await;
    let left = space("left");
    let left_group = conversation(&pool, "group", &left, &[&me, &nadia]).await;
    query("UPDATE cloud_chat_conversation_members SET membership_state = 'left', left_at = now() WHERE conversation_id = $1 AND account_id = $2")
        .bind(left_group)
        .bind(&nadia)
        .execute(&pool)
        .await
        .unwrap();
    conversation(&pool, "group", &space("theirs"), &[&nadia, &other]).await;

    let (status, body) = send(&app, "GET", &profile_path(&nadia), &token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["accountId"], nadia);
    assert_eq!(body["kind"], "person");
    assert_eq!(body["about"], "Robotics PhD.");
    assert_eq!(body["isSelf"], false);
    assert_eq!(body["isContact"], true);
    assert!(
        body["kordiId"].as_str().is_some_and(|id| id.len() == 9),
        "{body}"
    );
    assert_eq!(body["presence"]["status"], "online");
    assert_eq!(body["presence"]["lastSeenAt"], Value::Null);
    assert_eq!(
        body["defaultAgent"]["agentId"],
        format!("cloud-agent:{nadia}")
    );
    assert_eq!(
        body["defaultAgent"]["accountId"],
        format!("cloud-agent:{nadia}")
    );
    assert_eq!(body["owner"], Value::Null);
    assert_eq!(body["contactSince"], "2026-08-12T09:30:00+00:00");
    assert_eq!(body["shared"]["mediaCount"], 3);
    assert_eq!(body["shared"]["linkCount"], 1);
    assert_eq!(body["shared"]["documentCount"], 1);
    let groups: Vec<&str> = body["shared"]["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|group| group["groupId"].as_str().unwrap())
        .collect();
    assert_eq!(groups, vec![newer.as_str(), older.as_str()]);
    assert_eq!(
        body["shared"]["groups"][0]["title"],
        format!("Group {newer}")
    );
    assert_eq!(body["shared"]["groups"][0]["avatarUrl"], Value::Null);
    assert_eq!(body["commonGround"], Value::Null);
}

#[tokio::test]
async fn self_profile_is_allowed_without_shared_counts() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (me, token) = signed_in(&pool, "cp_self").await;
    let (status, body) = send(&app, "GET", &profile_path(&me), &token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["isSelf"], true);
    assert_eq!(body["isContact"], false);
    assert_eq!(body["contactSince"], Value::Null);
    assert_eq!(body["presence"]["status"], "offline");
    assert_eq!(
        body["shared"],
        json!({"mediaCount": 0, "linkCount": 0, "documentCount": 0, "groups": []})
    );
}

#[tokio::test]
async fn agent_contact_names_its_owner() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (me, token) = signed_in(&pool, "cp_agent_me").await;
    let (owner, _) = signed_in(&pool, "cp_agent_owner").await;
    let (stranger, _) = signed_in(&pool, "cp_agent_stranger").await;
    befriend(&pool, &me, &owner).await;

    let (status, body) = send(
        &app,
        "GET",
        &profile_path(&format!("cloud-agent:{owner}")),
        &token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["kind"], "agent");
    assert_eq!(body["accountId"], format!("cloud-agent:{owner}"));
    assert_eq!(body["kordiId"], Value::Null);
    assert_eq!(body["defaultAgent"], Value::Null);
    assert_eq!(body["owner"]["accountId"], owner);
    assert_eq!(body["owner"]["displayName"], "cp_agent_owner");
    assert!(body["owner"]["kordiId"].as_str().is_some(), "{body}");
    assert_eq!(body["contactSince"], Value::Null);
    assert_eq!(body["isContact"], true);
    assert_eq!(body["commonGround"], Value::Null);

    let (status, _) = send(
        &app,
        "GET",
        &profile_path(&format!("cloud-agent:{me}")),
        &token,
        None,
    )
    .await;
    assert_eq!(status, 200, "your own agent is visible");
    let (status, _) = send(
        &app,
        "GET",
        &profile_path(&format!("cloud-agent:{stranger}")),
        &token,
        None,
    )
    .await;
    assert_eq!(status, 404, "a stranger's agent is not visible");
}

#[tokio::test]
async fn non_contacts_and_unknown_accounts_are_not_found() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (_, token) = signed_in(&pool, "cp_404_me").await;
    let (stranger, _) = signed_in(&pool, "cp_404_stranger").await;
    for target in [
        stranger.as_str(),
        "acct_missing",
        "cloud-agent:acct_missing",
    ] {
        let (status, body) = send(&app, "GET", &profile_path(target), &token, None).await;
        assert_eq!(status, 404, "{target}");
        assert_eq!(body["errorCode"], "contact_not_found");
    }
}

#[tokio::test]
async fn about_is_trimmed_cleared_and_limited() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (_, token) = signed_in(&pool, "cp_about").await;
    let me = "/v1/cloud/auth/me";

    let (status, body) = send(&app, "GET", me, &token, None).await;
    assert_eq!(status, 200);
    assert_eq!(body["about"], Value::Null, "{body}");
    assert!(body.as_object().unwrap().contains_key("about"));

    let (status, body) = send(
        &app,
        "PATCH",
        me,
        &token,
        Some(json!({"about": "  Building a lab.  "})),
    )
    .await;
    assert_eq!(
        (status, body["about"].clone()),
        (200, json!("Building a lab."))
    );
    let (status, body) = send(
        &app,
        "PATCH",
        me,
        &token,
        Some(json!({"displayName": "Renamed"})),
    )
    .await;
    assert_eq!(
        (status, body["about"].clone()),
        (200, json!("Building a lab.")),
        "absent keeps it"
    );

    let limit = "a".repeat(280);
    let (status, body) = send(&app, "PATCH", me, &token, Some(json!({"about": limit}))).await;
    assert_eq!((status, body["about"].clone()), (200, json!(limit)));
    let (status, body) = send(
        &app,
        "PATCH",
        me,
        &token,
        Some(json!({"about": format!("{limit}a")})),
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(body["errorCode"], "invalid_about");
    let (_, body) = send(&app, "GET", me, &token, None).await;
    assert_eq!(
        body["about"],
        json!(limit),
        "a rejected update changes nothing"
    );

    let (status, body) = send(&app, "PATCH", me, &token, Some(json!({"about": "   "}))).await;
    assert_eq!((status, body["about"].clone()), (200, Value::Null));
    send(&app, "PATCH", me, &token, Some(json!({"about": "Again"}))).await;
    let (status, body) = send(&app, "PATCH", me, &token, Some(json!({"about": null}))).await;
    assert_eq!((status, body["about"].clone()), (200, Value::Null));
}

/// `commonGround` on the contact profile of `target` as `token` sees it.
async fn grounding(app: &axum::Router, token: &str, target: &str) -> Value {
    let (status, body) = send(app, "GET", &profile_path(target), token, None).await;
    assert_eq!(status, 200, "{body}");
    body["commonGround"].clone()
}

/// The owner's card as the fixture shares it: hidden topics removed, each
/// list holding four.
fn shared_fixture_card() -> Value {
    json!({
        "workingOn": ["Tabletop manipulation", "Sim-to-real", "Grasping", "Tactile"],
        "interests": ["Bouldering"],
        "canHelp": ["Grant writing"],
        "lookingFor": ["Robot datasets"],
        "match": null,
    })
}

#[tokio::test]
async fn contacts_see_a_shared_card_without_a_pairing_or_a_card_of_their_own() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (owner, _) = signed_in(&pool, "cp_cg_owner").await;
    let (paired, paired_token) = signed_in(&pool, "cp_cg_paired").await;
    let (contact, contact_token) = signed_in(&pool, "cp_cg_contact").await;
    card(&pool, &owner, true).await;
    befriend(&pool, &owner, &paired).await;
    card(&pool, &paired, true).await;
    pair(&pool, &owner, &paired).await;
    befriend(&pool, &owner, &contact).await;

    assert_eq!(
        grounding(&app, &paired_token, &owner).await,
        shared_fixture_card()
    );
    assert_eq!(
        grounding(&app, &contact_token, &owner).await,
        shared_fixture_card(),
        "no pairing and no card of their own"
    );
    // The paired contact keeps seeing it while their own card is not shared.
    query("UPDATE cloud_common_ground_cards SET sharing_enabled = false WHERE account_id = $1")
        .bind(&paired)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        grounding(&app, &paired_token, &owner).await,
        shared_fixture_card()
    );

    // The owner's sharing switch hides it from every contact.
    query("UPDATE cloud_common_ground_cards SET sharing_enabled = false WHERE account_id = $1")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    for token in [&paired_token, &contact_token] {
        assert_eq!(grounding(&app, token, &owner).await, Value::Null);
    }
}

#[tokio::test]
async fn see_my_card_off_blocks_and_strangers_hide_the_card() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (owner, _) = signed_in(&pool, "cp_cg_hide_owner").await;
    let (restricted, restricted_token) = signed_in(&pool, "cp_cg_restricted").await;
    let (blocked, blocked_token) = signed_in(&pool, "cp_cg_blocked").await;
    let (stranger, stranger_token) = signed_in(&pool, "cp_cg_stranger").await;
    card(&pool, &owner, true).await;
    befriend(&pool, &owner, &restricted).await;
    befriend(&pool, &owner, &blocked).await;

    card_access(&pool, &owner, &restricted, false).await;
    assert_eq!(
        grounding(&app, &restricted_token, &owner).await,
        Value::Null
    );
    card_access(&pool, &owner, &restricted, true).await;
    assert_eq!(
        grounding(&app, &restricted_token, &owner).await,
        shared_fixture_card()
    );

    block(&pool, &blocked, &owner).await;
    let (status, body) = send(&app, "GET", &profile_path(&owner), &blocked_token, None).await;
    assert!(
        status != 200 || body["commonGround"].is_null(),
        "{status} {body}"
    );

    let (status, _) = send(&app, "GET", &profile_path(&owner), &stranger_token, None).await;
    assert_eq!(status, 404);
    let found = crate::common_ground::profile_common_ground(&pool, &stranger, &owner, 4)
        .await
        .unwrap();
    assert_eq!(found, None, "not a contact");
}
