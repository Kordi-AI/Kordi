//! Grounding groups hold the notice account, which posts their notices, and
//! the System agent, so members can @ the Facilitator. Both are hidden service
//! members, and the startup backfill brings the System agent back into older
//! groups it was taken out of.

use serde_json::json;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::db_fixture::send;
use super::support::{make_contacts, people_in_a_room};
use crate::system_account::SYSTEM_ACCOUNT_ID;

fn system_agent() -> String {
    crate::system_agent::service_account_id()
        .unwrap()
        .to_string()
}

async fn start(app: &axum::Router, code: &str, token: &str, members: &[&str]) -> Uuid {
    let (status, body) = send(
        app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/group"),
        token,
        Some(json!({ "memberIds": members })),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    body["group"]["conversationId"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}

async fn state(pool: &PgPool, conversation_id: Uuid, account: &str) -> Option<String> {
    query_as(
        "SELECT membership_state FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation_id)
    .bind(account)
    .fetch_optional(pool)
    .await
    .unwrap()
    .map(|(state,): (String,)| state)
}

/// Makes `account` an active member the way the System agent's old backfill
/// did.
async fn add_member(pool: &PgPool, conversation_id: Uuid, account: &str) {
    query(
        "INSERT INTO cloud_chat_conversation_members
             (conversation_id, account_id, role, membership_state)
         VALUES ($1, $2, 'member', 'active')
         ON CONFLICT (conversation_id, account_id) DO UPDATE SET
             membership_state = 'active', left_at = NULL",
    )
    .bind(conversation_id)
    .bind(account)
    .execute(pool)
    .await
    .unwrap();
}

/// (sender, kind) of every message in a conversation, oldest first.
async fn senders(pool: &PgPool, conversation_id: Uuid) -> Vec<(String, String)> {
    query_as(
        "SELECT sender_account_id, message_kind FROM cloud_chat_messages
         WHERE conversation_id = $1 ORDER BY conversation_sequence",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[test]
fn system_and_system_agent_are_service_members() {
    assert_eq!(SYSTEM_ACCOUNT_ID, "acct_kordi_system");
    assert!(crate::system_account::is_service_account(SYSTEM_ACCOUNT_ID));
    assert!(crate::system_account::service_account_ids().contains(&SYSTEM_ACCOUNT_ID.to_string()));
    assert!(!crate::system_account::is_service_account("acct_someone"));
}

#[tokio::test]
async fn a_new_group_holds_system_and_system_agent_and_hides_both() {
    let Some(pool) = super::db_fixture::pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya"]).await;
    let [(alex, alex_token), (priya, _)] = [people[0].clone(), people[1].clone()];
    make_contacts(&pool, &alex, &priya).await;
    let conversation_id = start(&app, &code, &alex_token, &[&priya]).await;

    assert_eq!(
        state(&pool, conversation_id, SYSTEM_ACCOUNT_ID)
            .await
            .as_deref(),
        Some("active")
    );
    assert_eq!(
        state(&pool, conversation_id, &system_agent())
            .await
            .as_deref(),
        Some("active"),
        "members can @ the Facilitator"
    );
    let (display_name,): (Option<String>,) =
        query_as("SELECT display_name FROM cloud_accounts WHERE account_id = $1")
            .bind(SYSTEM_ACCOUNT_ID)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(display_name.as_deref(), Some("Facilitator"));

    let (_, results) = send(
        &app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/results"),
        &alex_token,
        None,
    )
    .await;
    let row = &results["groups"][0];
    assert_eq!(row["memberCount"], 2);
    assert!(!row.to_string().contains(SYSTEM_ACCOUNT_ID), "{row}");
    assert!(!row.to_string().contains(&system_agent()), "{row}");

    // A member list a client sends never removes System.
    let request = crate::chat_sync::models::AddConversationMembersRequest {
        client_operation_id: Uuid::new_v4(),
        member_account_ids: vec![alex.clone(), priya.clone()],
        replace: true,
    };
    crate::chat_sync::store::add_conversation_members(&pool, &alex, conversation_id, request)
        .await
        .unwrap();
    assert_eq!(
        state(&pool, conversation_id, SYSTEM_ACCOUNT_ID)
            .await
            .as_deref(),
        Some("active")
    );
}

#[tokio::test]
async fn an_older_group_with_only_system_agent_gets_its_joined_line_from_system() {
    let Some(pool) = super::db_fixture::pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Sam"]).await;
    let [(alex, alex_token), (priya, _), (sam, sam_token)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    make_contacts(&pool, &alex, &priya).await;
    let conversation_id = start(&app, &code, &alex_token, &[&sam, &priya]).await;
    // Like an older group: the System agent is in it, System is not.
    query(
        "DELETE FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation_id)
    .bind(SYSTEM_ACCOUNT_ID)
    .execute(&pool)
    .await
    .unwrap();
    add_member(&pool, conversation_id, &system_agent()).await;

    let (_, theirs) = send(
        &app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/results"),
        &sam_token,
        None,
    )
    .await;
    let reference = theirs["invitations"][0]["invitationRef"].as_str().unwrap();
    let (status, body) = send(
        &app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/invitations/{reference}/join"),
        &sam_token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        state(&pool, conversation_id, SYSTEM_ACCOUNT_ID)
            .await
            .as_deref(),
        Some("active")
    );
    assert_eq!(
        senders(&pool, conversation_id).await,
        vec![(SYSTEM_ACCOUNT_ID.to_string(), "system-notice".to_string())]
    );
}

#[tokio::test]
async fn startup_brings_system_agent_back_into_grounding_groups() {
    let Some(pool) = super::db_fixture::pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya"]).await;
    let [(alex, alex_token), (priya, _)] = [people[0].clone(), people[1].clone()];
    make_contacts(&pool, &alex, &priya).await;
    let room_group = start(&app, &code, &alex_token, &[&priya]).await;
    let system_agent = system_agent();
    // Like a group the System agent was taken out of before it could be
    // mentioned in Grounding groups.
    query(
        "UPDATE cloud_chat_conversation_members SET membership_state = 'removed'
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(room_group)
    .bind(&system_agent)
    .execute(&pool)
    .await
    .unwrap();
    let events = |pool: PgPool| {
        let alex = alex.clone();
        async move {
            let (count,): (i64,) = query_as(
                "SELECT COUNT(*) FROM cloud_chat_user_sync_events
                 WHERE account_id = $1 AND conversation_id = $2
                   AND event_type = 'membership.updated'",
            )
            .bind(&alex)
            .bind(room_group)
            .fetch_one(&pool)
            .await
            .unwrap();
            count
        }
    };
    let before = events(pool.clone()).await;

    crate::system_agent::membership::join_all_groups(&pool, &system_agent)
        .await
        .unwrap();
    assert_eq!(
        state(&pool, room_group, &system_agent).await.as_deref(),
        Some("active")
    );
    assert_eq!(
        events(pool.clone()).await,
        before + 1,
        "devices hear about it"
    );
    assert_eq!(
        state(&pool, room_group, SYSTEM_ACCOUNT_ID).await.as_deref(),
        Some("active"),
        "the notice account stays"
    );
}

/// Posts `text` from `sender` as a plain message, five minutes old.
async fn say(pool: &PgPool, sender: &str, conversation_id: Uuid, text: &str) {
    let request = crate::chat_sync::models::SendMessageRequest {
        client_message_id: Uuid::new_v4(),
        kind: "text".to_string(),
        content: json!({"schema": 1, "blocks": [{"type": "text", "text": text}], "legacy_attachments": []}),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    crate::chat_sync::store::send_message(pool, sender, conversation_id, request)
        .await
        .unwrap();
    query(
        "UPDATE cloud_chat_messages SET created_at = now() - interval '5 minutes'
         WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .execute(pool)
    .await
    .unwrap();
}

/// Runs one sweep with this group first in line, and counts the System
/// agent's runs for it.
async fn sweep_runs(pool: &PgPool, conversation_id: Uuid) -> i64 {
    query(
        "UPDATE cloud_pip_conversation_state SET checked_at = now() - interval '1 day'
         WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .execute(pool)
    .await
    .unwrap();
    let config = crate::system_agent::test_config(&system_agent());
    crate::system_agent::store::sweep(pool, &config)
        .await
        .unwrap();
    let (count,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_agent_fallback_runs run
         JOIN cloud_chat_conversations conversation
           ON conversation.legacy_session_id = run.session_id
         WHERE conversation.conversation_id = $1 AND run.owner_account_id = $2
           AND run.run_id LIKE $3",
    )
    .bind(conversation_id)
    .bind(system_agent())
    .bind(format!("{}%", crate::system_agent::RUN_PREFIX))
    .fetch_one(pool)
    .await
    .unwrap();
    count
}

#[tokio::test]
async fn system_agent_answers_a_mention_in_a_grounding_group_but_never_steps_in() {
    let Some(pool) = super::db_fixture::pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya"]).await;
    let [(alex, alex_token), (priya, _)] = [people[0].clone(), people[1].clone()];
    make_contacts(&pool, &alex, &priya).await;
    let room_group = start(&app, &code, &alex_token, &[&priya]).await;

    // Plan talk that has gone quiet is left to the people.
    say(&pool, &priya, room_group, "Dinner Friday at 7?").await;
    query(
        "UPDATE cloud_chat_messages SET created_at = now() - interval '1 hour'
         WHERE conversation_id = $1",
    )
    .bind(room_group)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(sweep_runs(&pool, room_group).await, 0);

    // Asking the Facilitator by name gets an answer.
    say(
        &pool,
        &alex,
        room_group,
        "@Facilitator can you suggest a time?",
    )
    .await;
    assert_eq!(sweep_runs(&pool, room_group).await, 1);
}
