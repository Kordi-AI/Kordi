//! Direct conversations of a deleted account: emptied for a person deleting
//! their own account, kept read-only for the other person when an operator
//! deletes it.

use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

const DIRECT_PREFIX: &str = "kordi-cloud-message:";

fn envelope(value: &Value) -> Value {
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap());
    text(&format!("{DIRECT_PREFIX}{encoded}"))
}

fn decoded(content: &Value) -> String {
    let text = content["blocks"][0]["text"].as_str().unwrap_or_default();
    match text.strip_prefix(DIRECT_PREFIX) {
        Some(encoded) => String::from_utf8(URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap(),
        None => text.to_string(),
    }
}

#[tokio::test]
async fn the_default_policy_still_empties_a_direct_conversation() {
    let Some(pool) = pool().await else { return };
    let (gone, _) = person(&pool, "Avery Sample").await;
    let (stays, _) = person(&pool, "Blake Sample").await;
    let conversation = direct_conversation(&pool, &gone, &stays).await;
    send(&pool, &gone, conversation, text("First"))
        .await
        .unwrap();
    send(&pool, &stays, conversation, text("Second"))
        .await
        .unwrap();

    let deletion = delete(&pool, &gone, DirectConversations::Empty).await;

    assert_eq!(deletion.conversations.direct, 1);
    assert_eq!(deletion.conversations.direct_kept, 0);
    assert!(messages(&pool, conversation).await.is_empty());
    assert_eq!(
        members(&pool, conversation).await,
        vec![(stays.clone(), "removed".to_string())]
    );
}

#[tokio::test]
async fn keep_leaves_the_other_person_the_whole_history_from_the_stand_in() {
    let Some(pool) = pool().await else { return };
    let (gone, gone_email) = person(&pool, "Casey Sample").await;
    let (stays, _) = person(&pool, "Drew Sample").await;
    let conversation = direct_conversation(&pool, &gone, &stays).await;
    let (session_before,): (Option<String>,) = query_as(
        "SELECT legacy_session_id FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(conversation)
    .fetch_one(&pool)
    .await
    .unwrap();
    let from_gone = send(
        &pool,
        &gone,
        conversation,
        text(&format!("Reach me at {gone}")),
    )
    .await
    .unwrap();
    send(&pool, &stays, conversation, text("Sounds good"))
        .await
        .unwrap();
    // Drew asks Casey's agent something; the envelope names Casey.
    send(
        &pool,
        &stays,
        conversation,
        envelope(&json!({
            "schemaVersion": 1,
            "kind": "message",
            "text": "Can your agent check?",
            "mentions": [{"accountId": gone, "displayName": "Casey Sample"}],
            "targetCloudAgentId": "agent_fixture",
            "targetCloudAgentName": "Casey Sample's Kordi",
            "targetCloudAgentOwnerAccountId": gone,
            "targetCloudAgentOwnerName": "Casey Sample",
        })),
    )
    .await
    .unwrap();
    for (card, creator) in [("plan-gone", &gone), ("plan-stays", &stays)] {
        query(
            "INSERT INTO cloud_plan_cards \
             (event_id, conversation_id, state, title, created_by_account_id) \
             VALUES ($1, $2, 'polling', 'Lunch', $3)",
        )
        .bind(format!("{card}-{conversation}"))
        .bind(conversation)
        .bind(creator)
        .execute(&pool)
        .await
        .unwrap();
    }

    let deletion = delete(&pool, &gone, DirectConversations::Keep).await;

    assert_eq!(deletion.conversations.direct_kept, 1);
    assert_eq!(deletion.conversations.direct, 0);
    assert!(!account_exists(&pool, &gone).await);
    // Every message stays; Casey's are from the stand-in, and nothing
    // stored names Casey any more.
    let kept = messages(&pool, conversation).await;
    assert_eq!(kept.len(), 3);
    for (id, sender, content) in &kept {
        let shown = decoded(content);
        assert!(!shown.contains(&gone), "{shown}");
        assert!(!shown.contains(&gone_email), "{shown}");
        assert!(!shown.contains("Casey Sample"), "{shown}");
        if *id == from_gone {
            assert_eq!(sender, DELETED_ACCOUNT_ID);
            assert!(shown.contains(DELETED_ACCOUNT_ID), "{shown}");
        } else {
            assert_eq!(sender, &stays);
        }
    }
    let mut expected = vec![
        (DELETED_ACCOUNT_ID.to_string(), "left".to_string()),
        (stays.clone(), "active".to_string()),
    ];
    expected.sort();
    assert_eq!(members(&pool, conversation).await, expected);
    // Both plan cards stay, Casey's from the stand-in.
    let cards: Vec<(String,)> = query_as(
        "SELECT created_by_account_id FROM cloud_plan_cards WHERE conversation_id = $1 \
         ORDER BY event_id",
    )
    .bind(conversation)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        cards,
        vec![(DELETED_ACCOUNT_ID.to_string(),), (stays.clone(),)]
    );

    // Drew still has it, read-only, closed by the stand-in, under the same
    // session id.
    let bootstrap = store::bootstrap(&pool, &stays).await.unwrap();
    let listed = bootstrap
        .conversations
        .iter()
        .find(|listed| listed.id == conversation)
        .expect("the kept direct conversation is still listed");
    assert_eq!(listed.legacy_session_id, session_before);
    let closed = listed.closed.as_ref().expect("closed");
    assert_eq!(
        closed.closed_by_account_id.as_deref(),
        Some(DELETED_ACCOUNT_ID)
    );
    match send(&pool, &stays, conversation, text("Are you there?")).await {
        Err(store::StoreError::Conflict { code, .. }) => {
            assert_eq!(code, store::GROUP_CLOSED_CODE)
        }
        other => panic!("a send to a kept direct conversation must be refused: {other:?}"),
    }
    assert_eq!(messages(&pool, conversation).await.len(), 3);
    // Drew's devices hear of the new member list and the close, not a removal.
    let events: Vec<(String,)> = query_as(
        "SELECT event_type FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND conversation_id = $2 ORDER BY stream_seq",
    )
    .bind(&stays)
    .bind(conversation)
    .fetch_all(&pool)
    .await
    .unwrap();
    let events: Vec<&str> = events.iter().map(|(kind,)| kind.as_str()).collect();
    assert!(events.contains(&"membership.updated"), "{events:?}");
    assert!(events.contains(&"conversation.updated"), "{events:?}");
    assert!(!events.contains(&"membership.removed"), "{events:?}");
}

#[tokio::test]
async fn one_person_keeps_two_direct_conversations_after_both_peers_are_deleted() {
    let Some(pool) = pool().await else { return };
    let (stays, _) = person(&pool, "Emery Sample").await;
    let (first, _) = person(&pool, "Finley Sample").await;
    let (second, _) = person(&pool, "Gray Sample").await;
    let with_first = direct_conversation(&pool, &stays, &first).await;
    let with_second = direct_conversation(&pool, &second, &stays).await;
    for (sender, conversation) in [
        (&first, with_first),
        (&stays, with_first),
        (&second, with_second),
        (&stays, with_second),
    ] {
        send(&pool, sender, conversation, text("Hello"))
            .await
            .unwrap();
    }

    delete(&pool, &first, DirectConversations::Keep).await;
    delete(&pool, &second, DirectConversations::Keep).await;

    for conversation in [with_first, with_second] {
        let mut expected = vec![
            (DELETED_ACCOUNT_ID.to_string(), "left".to_string()),
            (stays.clone(), "active".to_string()),
        ];
        expected.sort();
        assert_eq!(members(&pool, conversation).await, expected);
        let senders: Vec<String> = messages(&pool, conversation)
            .await
            .into_iter()
            .map(|(_, sender, _)| sender)
            .collect();
        assert_eq!(senders, vec![DELETED_ACCOUNT_ID.to_string(), stays.clone()]);
    }
    let listed: Vec<Uuid> = store::bootstrap(&pool, &stays)
        .await
        .unwrap()
        .conversations
        .into_iter()
        .map(|conversation| conversation.id)
        .collect();
    assert!(listed.contains(&with_first) && listed.contains(&with_second));

    // Neither is "the direct conversation with the stand-in", and none can
    // be opened with it: service accounts never count as a member.
    let with_stand_in = crate::auth::routes::direct_person_session_id(&stays, DELETED_ACCOUNT_ID);
    assert_eq!(
        store::conversation_id_for_session(&pool, &stays, &with_stand_in)
            .await
            .unwrap(),
        None
    );
    let mut tx = pool.begin().await.unwrap();
    let opened =
        crate::auth::routes::open_direct_conversation(&mut tx, &stays, DELETED_ACCOUNT_ID).await;
    assert!(
        matches!(opened, Err(store::StoreError::InvalidInput(_))),
        "{opened:?}"
    );
    tx.rollback().await.unwrap();

    // When Emery leaves Kordi too, nobody is left in either conversation.
    let deletion = delete(&pool, &stays, DirectConversations::Empty).await;
    assert_eq!(deletion.conversations.deleted, 2);
    let (remaining,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_chat_conversations WHERE conversation_id = ANY($1)")
            .bind(vec![with_first, with_second])
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(remaining, 0);
}
