//! What everyone in a group reads when someone joins through a person
//! invitation, and the joiner's first message right after joining.

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::db_fixture::send;
use super::group_invitation_support::{setup, Setup};
use crate::chat_sync::models::{ConversationKind, CreateConversationRequest, SendMessageRequest};
use crate::chat_sync::store;

const CG: &str = "/v1/cloud/common-ground";

/// The joined notices `viewer` reads in `conversation`, as (sender, text).
async fn joined_notices(s: &Setup, viewer: &str, conversation: Uuid) -> Vec<(String, String)> {
    store::history(&s.pool, viewer, conversation, None, None)
        .await
        .unwrap()
        .messages
        .into_iter()
        .filter(|message| {
            message.kind == "system-notice"
                && message.content["group_event"]["type"] == store::GROUP_MEMBER_JOINED_EVENT
        })
        .map(|message| {
            let text = message.content["blocks"][0]["text"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            (message.sender_account_id, text)
        })
        .collect()
}

/// How many live message events about a joined notice `account` got.
async fn joined_events(s: &Setup, account: &str, conversation: Uuid) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_chat_user_sync_events
         WHERE account_id = $1 AND conversation_id = $2 AND event_type = 'message.created'
           AND payload::text LIKE '%group.member_joined%'",
    )
    .bind(account)
    .bind(conversation)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    count
}

/// Sam's invitation to `space` from Alex, answered with Join.
async fn sam_joins(s: &Setup, space: &str) -> Value {
    let (status, body) = send(
        &s.app,
        "POST",
        &format!("{CG}/group-invitations"),
        &s.alex.1,
        Some(json!({ "groupSpaceId": space, "accountIds": [s.sam.0] })),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let invitation = s
        .group_pending(&s.sam.1)
        .await
        .into_iter()
        .find(|invitation| invitation["groupSpaceId"] == space)
        .expect("Sam's invitation");
    let reference = invitation["invitationRef"].clone();
    let (status, body) = s.answer(&s.sam.1, &reference, "join").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "joined");
    reference
}

#[tokio::test]
async fn everyone_reads_who_joined_a_group_and_the_joiner_can_post_at_once() {
    let Some(s) = setup().await else {
        return;
    };
    // A plain group Alex owns with Priya, not started from a room.
    let group = store::create_conversation(
        &s.pool,
        &s.alex.0,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Group,
            shared_title: Some("Launch".to_string()),
            client_session_id: format!("session:group:{}", Uuid::now_v7()),
            member_account_ids: vec![s.priya.0.clone()],
            organization_id: None,
        },
    )
    .await
    .unwrap()
    .value;
    let session = group.legacy_session_id.clone().unwrap();
    let space = group.group_space_id.clone().unwrap_or(session.clone());

    let reference = sam_joins(&s, &space).await;
    let expected = vec![(s.sam.0.clone(), "Sam joined the group".to_string())];
    for viewer in [&s.alex.0, &s.priya.0, &s.sam.0] {
        assert_eq!(joined_notices(&s, viewer, group.id).await, expected);
        assert_eq!(
            joined_events(&s, viewer, group.id).await,
            1,
            "{viewer} reads it live"
        );
    }

    // Joining again posts nothing new.
    let (status, body) = s.answer(&s.sam.1, &reference, "join").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "already_joined");
    assert_eq!(joined_notices(&s, &s.alex.0, group.id).await, expected);

    // The joiner's device may still list the group as it was before they
    // joined; opening it returns the group as it is instead of refusing.
    let opened = store::create_conversation(
        &s.pool,
        &s.sam.0,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Group,
            shared_title: None,
            client_session_id: session,
            member_account_ids: vec![s.alex.0.clone()],
            organization_id: None,
        },
    )
    .await
    .unwrap();
    assert!(!opened.inserted);
    assert_eq!(opened.value.id, group.id);
    let sent = store::send_message(
        &s.pool,
        &s.sam.0,
        group.id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".to_string(),
            content: json!({
                "schema": 1,
                "blocks": [{ "type": "text", "text": "hi" }],
                "legacy_attachments": [],
            }),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .unwrap();
    assert!(sent.inserted);
}

#[tokio::test]
async fn a_group_started_from_a_room_keeps_its_own_joined_line() {
    let Some(s) = setup().await else {
        return;
    };
    sam_joins(&s, s.space()).await;
    assert!(
        joined_notices(&s, &s.alex.0, s.conversation())
            .await
            .is_empty(),
        "System's room line, not a second notice"
    );
}
