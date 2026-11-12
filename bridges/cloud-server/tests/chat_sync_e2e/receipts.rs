//! Delivery moves reach only the mover; read moves reach the mover and the
//! authors whose read watermark they raise, never the whole conversation.

use super::group_lifecycle::group_request;
use super::*;
use kordi_cloud_server::chat_sync::models::ConversationCursorSnapshot;

#[path = "read_watermark.rs"]
mod read_watermark;
#[path = "readers.rs"]
mod readers;
#[path = "receipt_lock_order.rs"]
mod receipt_lock_order;

/// One cursor event as a recipient stores it: (event type, whose cursor,
/// delivered, read, the recipient's new read watermark when it carries one).
pub(super) type CursorEvent = (String, String, i64, i64, Option<i64>);

pub(super) fn cursor_request(sequence: i64) -> AdvanceConversationCursorRequest {
    AdvanceConversationCursorRequest {
        client_operation_id: Uuid::now_v7(),
        sequence,
    }
}

pub(super) async fn deliver(pool: &PgPool, account: &str, conversation: Uuid, sequence: i64) {
    store::advance_delivery_cursor(pool, account, conversation, cursor_request(sequence))
        .await
        .expect("advance delivery cursor");
}

pub(super) async fn read(pool: &PgPool, account: &str, conversation: Uuid, sequence: i64) {
    store::advance_read_cursor(pool, account, conversation, cursor_request(sequence))
        .await
        .expect("advance read cursor");
}

/// Sends a text message and returns its conversation sequence.
pub(super) async fn send(pool: &PgPool, sender: &str, conversation: Uuid, text: &str) -> i64 {
    store::send_message(
        pool,
        sender,
        conversation,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".to_string(),
            content: content(text),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("send message")
    .value
    .conversation_sequence
}

/// The cursor events `account` received for `conversation`, oldest first.
pub(super) async fn cursor_events(
    pool: &PgPool,
    account: &str,
    conversation: Uuid,
) -> Vec<CursorEvent> {
    query_as::<_, (String, serde_json::Value)>(
        "SELECT event_type, payload FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND conversation_id = $2 \
           AND event_type IN ('delivery_cursor.updated', 'read_cursor.updated') \
         ORDER BY stream_seq ASC",
    )
    .bind(account)
    .bind(conversation)
    .fetch_all(pool)
    .await
    .expect("load cursor events")
    .into_iter()
    .map(|(event_type, payload)| {
        let cursor = &payload["cursor"];
        let read_outbox = payload.get("read_outbox").map(|outbox| {
            assert_eq!(outbox["conversation_id"], json!(conversation));
            outbox["sequence"].as_i64().expect("watermark sequence")
        });
        (
            event_type,
            cursor["account_id"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            cursor["last_delivered_sequence"].as_i64().unwrap_or(-1),
            cursor["last_read_sequence"].as_i64().unwrap_or(-1),
            read_outbox,
        )
    })
    .collect()
}

pub(super) fn delivered_event(mover: &str, delivered: i64, read: i64) -> CursorEvent {
    (
        "delivery_cursor.updated".to_string(),
        mover.to_string(),
        delivered,
        read,
        None,
    )
}

/// A read move as the mover's own devices get it.
pub(super) fn read_event(mover: &str, delivered: i64, read: i64) -> CursorEvent {
    (
        "read_cursor.updated".to_string(),
        mover.to_string(),
        delivered,
        read,
        None,
    )
}

/// A read move as an author gets it: the reader's cursor and the author's new
/// read watermark.
pub(super) fn author_event(mover: &str, read: i64, watermark: i64) -> CursorEvent {
    (
        "read_cursor.updated".to_string(),
        mover.to_string(),
        read,
        read,
        Some(watermark),
    )
}

/// `account`'s read watermark in `conversation`, as member snapshots carry it.
pub(super) async fn watermark(pool: &PgPool, account: &str, conversation: Uuid) -> i64 {
    query_as::<_, (i64,)>(
        "SELECT sequence FROM cloud_chat_read_outbox \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation)
    .bind(account)
    .fetch_optional(pool)
    .await
    .expect("load read watermark")
    .map_or(0, |row| row.0)
}

/// A group `labels[0]` created with everyone else in it. Group creation posts
/// the "created the group" line as message 1, written by the creator.
pub(super) async fn group_of<const N: usize>(
    pool: &PgPool,
    labels: [&str; N],
) -> (Uuid, [String; N]) {
    let mut people = Vec::new();
    for label in labels {
        people.push(account(pool, label).await);
    }
    for member in &people[1..] {
        connect_accounts(pool, &people[0], member).await;
    }
    let group =
        store::create_conversation(pool, &people[0], group_request(people[1..].to_vec(), None))
            .await
            .expect("create group")
            .value;
    (group.id, people.try_into().expect("one account per label"))
}

#[tokio::test]
async fn a_read_reaches_only_the_author_and_the_reader() {
    let Some(pool) = try_pool().await else { return };
    let (group, people) = group_of(&pool, ["Ava", "Ben", "Cal", "Dee", "Eli"]).await;
    let [ava, ben, cal, dee, eli] = &people;
    let message = send(&pool, ava, group, "Synthetic agenda for Friday").await;
    let ava_head = sync_head(&pool, ava).await.0;
    let quiet_heads = [
        sync_head(&pool, cal).await.0,
        sync_head(&pool, dee).await.0,
        sync_head(&pool, eli).await.0,
    ];

    deliver(&pool, ben, group, message).await;
    read(&pool, ben, group, message).await;

    // Ben's devices see both moves; Ava hears only that Ben read her message.
    assert_eq!(
        cursor_events(&pool, ben, group).await,
        vec![
            delivered_event(ben, message, 0),
            read_event(ben, message, message),
        ]
    );
    assert_eq!(
        cursor_events(&pool, ava, group).await,
        vec![author_event(ben, message, message)]
    );
    for (person, head) in [cal, dee, eli].into_iter().zip(quiet_heads) {
        assert!(cursor_events(&pool, person, group).await.is_empty());
        assert_eq!(sync_head(&pool, person).await.0, head, "{person} was woken");
    }

    // Ava's own stream carries Ben's cursor and her new watermark.
    let batch = store::sync_batch(&pool, ava, ava_head, Some(10))
        .await
        .unwrap();
    assert_eq!(batch.events.len(), 1);
    eprintln!(
        "author read_cursor.updated payload: {}",
        batch.events[0].payload
    );
    assert_eq!(
        batch.events[0].payload["read_outbox"],
        json!({ "conversation_id": group, "sequence": message })
    );
    let cursor: ConversationCursorSnapshot =
        serde_json::from_value(batch.events[0].payload["cursor"].clone()).unwrap();
    assert_eq!(
        cursor,
        ConversationCursorSnapshot {
            conversation_id: group,
            account_id: ben.clone(),
            last_delivered_sequence: message,
            last_read_sequence: message,
        }
    );
}

#[tokio::test]
async fn a_read_past_two_authors_gives_each_their_own_watermark() {
    let Some(pool) = try_pool().await else { return };
    let (group, people) = group_of(&pool, ["Ava", "Ben", "Cal", "Dee", "Eli"]).await;
    let [ava, ben, cal, dee, eli] = &people;
    let first = send(&pool, ava, group, "Synthetic first draft").await;
    let second = send(&pool, cal, group, "Synthetic second draft").await;
    let last = send(&pool, ava, group, "Synthetic third draft").await;

    read(&pool, dee, group, last).await;

    assert!(first < second && second < last);
    assert_eq!(
        cursor_events(&pool, ava, group).await,
        vec![author_event(dee, last, last)]
    );
    assert_eq!(
        cursor_events(&pool, cal, group).await,
        vec![author_event(dee, last, second)]
    );
    assert_eq!(
        cursor_events(&pool, dee, group).await,
        vec![read_event(dee, last, last)]
    );
    assert_eq!(watermark(&pool, ava, group).await, last);
    assert_eq!(watermark(&pool, cal, group).await, second);
    // Ben and Eli wrote nothing in the range.
    for person in [ben, eli] {
        assert!(
            cursor_events(&pool, person, group).await.is_empty(),
            "{person}"
        );
    }
}

#[tokio::test]
async fn a_move_past_only_the_readers_own_messages_reaches_only_the_reader() {
    let Some(pool) = try_pool().await else { return };
    let (group, people) = group_of(&pool, ["Ava", "Ben", "Cal", "Dee", "Eli"]).await;
    let [ava, ben, cal, dee, eli] = &people;
    // Ben first reads Ava's "created the group" line, which Ava hears about.
    read(&pool, ben, group, 1).await;
    assert_eq!(
        cursor_events(&pool, ava, group).await,
        vec![author_event(ben, 1, 1)]
    );
    send(&pool, ben, group, "Synthetic note one").await;
    let last = send(&pool, ben, group, "Synthetic note two").await;

    deliver(&pool, ben, group, last).await;
    read(&pool, ben, group, last).await;

    assert_eq!(
        cursor_events(&pool, ben, group).await,
        vec![
            read_event(ben, 1, 1),
            delivered_event(ben, last, 1),
            read_event(ben, last, last),
        ]
    );
    assert_eq!(
        cursor_events(&pool, ava, group).await,
        vec![author_event(ben, 1, 1)]
    );
    assert_eq!(watermark(&pool, ben, group).await, 0);
    for person in [cal, dee, eli] {
        assert!(
            cursor_events(&pool, person, group).await.is_empty(),
            "{person}"
        );
    }
}

#[tokio::test]
async fn a_delivery_reaches_only_the_movers_devices() {
    let Some(pool) = try_pool().await else { return };
    let (group, people) = group_of(&pool, ["Ava", "Ben", "Cal", "Dee"]).await;
    let [ava, ben, cal, dee] = &people;
    send(&pool, cal, group, "Synthetic early message").await;
    let last = send(&pool, dee, group, "Synthetic later message").await;
    let heads = [
        sync_head(&pool, ava).await.0,
        sync_head(&pool, cal).await.0,
        sync_head(&pool, dee).await.0,
    ];

    deliver(&pool, ben, group, last).await;

    assert_eq!(
        cursor_events(&pool, ben, group).await,
        vec![delivered_event(ben, last, 0)]
    );
    for (person, head) in [ava, cal, dee].into_iter().zip(heads) {
        assert!(cursor_events(&pool, person, group).await.is_empty());
        assert_eq!(sync_head(&pool, person).await.0, head, "{person} was woken");
        assert_eq!(watermark(&pool, person, group).await, 0, "{person}");
    }
    let marks = query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM cloud_chat_read_marks WHERE conversation_id = $1",
    )
    .bind(group)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(marks.0, 0, "delivery writes no read mark");
}

#[tokio::test]
async fn a_direct_peer_still_hears_reads_of_their_messages() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "direct-receipt-owner").await;
    let peer = account(&pool, "direct-receipt-peer").await;
    connect_accounts(&pool, &owner, &peer).await;
    let direct = store::create_conversation(
        &pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: direct_person_session_id(&owner, &peer),
            member_account_ids: vec![peer.clone()],
            organization_id: None,
        },
    )
    .await
    .unwrap()
    .value
    .id;
    let first = send(&pool, &owner, direct, "Synthetic hello").await;

    deliver(&pool, &peer, direct, first).await;
    read(&pool, &peer, direct, first).await;
    assert_eq!(
        cursor_events(&pool, &owner, direct).await,
        vec![author_event(&peer, first, first)]
    );
    assert_eq!(
        cursor_events(&pool, &peer, direct).await,
        vec![
            delivered_event(&peer, first, 0),
            read_event(&peer, first, first),
        ]
    );

    let reply = send(&pool, &peer, direct, "Synthetic reply").await;
    read(&pool, &owner, direct, reply).await;
    assert_eq!(
        cursor_events(&pool, &peer, direct).await.last(),
        Some(&author_event(&owner, reply, reply))
    );
    assert_eq!(
        cursor_events(&pool, &owner, direct).await.last(),
        Some(&read_event(&owner, reply, reply))
    );
}

#[tokio::test]
async fn a_repeated_receipt_returns_the_stored_cursor_and_writes_nothing() {
    let Some(pool) = try_pool().await else { return };
    let (group, people) = group_of(&pool, ["Ava", "Ben", "Cal", "Dee", "Eli"]).await;
    let [ava, ben, ..] = &people;
    let message = send(&pool, ava, group, "Synthetic retry check").await;
    let request = cursor_request(message);

    let first = store::advance_read_cursor(&pool, ben, group, request.clone())
        .await
        .unwrap();
    let heads = (sync_head(&pool, ava).await.0, sync_head(&pool, ben).await.0);
    let retried = store::advance_read_cursor(&pool, ben, group, request)
        .await
        .unwrap();

    assert_eq!(retried, first);
    assert_eq!(
        (sync_head(&pool, ava).await.0, sync_head(&pool, ben).await.0),
        heads
    );
    assert_eq!(cursor_events(&pool, ava, group).await.len(), 1);
    assert_eq!(cursor_events(&pool, ben, group).await.len(), 1);
}
