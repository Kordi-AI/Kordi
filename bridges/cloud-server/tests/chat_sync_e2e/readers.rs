//! The "Seen by" list: who read one of the caller's messages, and when.

use super::*;
use chrono::{DateTime, Utc};
use kordi_cloud_server::chat_sync::models::MessageReader;
use kordi_cloud_server::system_account::{self, SYSTEM_ACCOUNT_ID};

#[path = "readers_http.rs"]
mod readers_http;

/// The stored id of the message at `sequence`.
async fn message_id_at(pool: &PgPool, conversation: Uuid, sequence: i64) -> Uuid {
    query_as::<_, (Uuid,)>(
        "SELECT message_id FROM cloud_chat_messages \
         WHERE conversation_id = $1 AND conversation_sequence = $2",
    )
    .bind(conversation)
    .bind(sequence)
    .fetch_one(pool)
    .await
    .expect("load message id")
    .0
}

/// Adds `count` new active members straight to the conversation, past the
/// group size the routes allow.
pub(super) async fn add_people(pool: &PgPool, conversation: Uuid, count: usize) {
    let ids = (0..count)
        .map(|_| format!("chat-crowd-{}", Uuid::new_v4().simple()))
        .collect::<Vec<_>>();
    query(
        "INSERT INTO cloud_accounts(account_id, display_name, avatar_url, created_at, \
             updated_at, avatar_source, avatar_style, avatar_seed, avatar_renderer_version, \
             avatar_version, avatar_updated_at) \
         SELECT id, 'Crowd', 'https://avatars.example/crowd.png', $2, $2, 'uploaded', \
                'lorelei', id, 'dicebear-rust-10.6.0-styles-10.5.0', 1, $2 \
         FROM UNNEST($1::TEXT[]) AS id",
    )
    .bind(&ids)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .expect("create crowd accounts");
    query(
        "INSERT INTO cloud_chat_conversation_members (conversation_id, account_id) \
         SELECT $1, id FROM UNNEST($2::TEXT[]) AS id",
    )
    .bind(conversation)
    .bind(&ids)
    .execute(pool)
    .await
    .expect("add crowd members");
}

/// Sets `account`'s cursors without a read mark, as a read before marks existed.
async fn set_cursor_without_mark(pool: &PgPool, conversation: Uuid, account: &str, at: i64) {
    query(
        "UPDATE cloud_chat_conversation_members \
         SET last_delivered_sequence = $3, last_read_sequence = $3 \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation)
    .bind(account)
    .bind(at)
    .execute(pool)
    .await
    .expect("set cursor");
}

/// Moves `account`'s mark through `through` to `hours_ago` and returns it.
async fn date_mark(
    pool: &PgPool,
    conversation: Uuid,
    account: &str,
    through: i64,
    hours_ago: i32,
) -> DateTime<Utc> {
    query_as::<_, (DateTime<Utc>,)>(
        "UPDATE cloud_chat_read_marks SET read_at = now() - make_interval(hours => $4) \
         WHERE conversation_id = $1 AND account_id = $2 AND through_sequence = $3 \
         RETURNING read_at",
    )
    .bind(conversation)
    .bind(account)
    .bind(through)
    .bind(hours_ago)
    .fetch_one(pool)
    .await
    .expect("date read mark")
    .0
}

fn reader(account_id: &str, read_at: Option<DateTime<Utc>>) -> MessageReader {
    MessageReader {
        account_id: account_id.to_string(),
        read_at,
    }
}

#[tokio::test]
async fn the_author_sees_who_read_in_the_order_they_read() {
    let Some(pool) = try_pool().await else { return };
    let (group, people) = group_of(&pool, ["Ava", "Ben", "Cal", "Dee", "Eli", "Fay"]).await;
    let [ava, ben, cal, dee, eli, fay] = &people;
    system_account::join(&pool, group).await.unwrap();
    let message = send(&pool, ava, group, "Synthetic seen-by check").await;
    let message_id = message_id_at(&pool, group, message).await;
    read(&pool, ben, group, message).await;
    read(&pool, cal, group, message).await;
    let later = send(&pool, ava, group, "Synthetic follow-up").await;
    read(&pool, ben, group, later).await;
    // Dee read before marks existed; Eli read and left; Fay has not read;
    // System's cursor never makes it a reader.
    set_cursor_without_mark(&pool, group, dee, message).await;
    set_cursor_without_mark(&pool, group, SYSTEM_ACCOUNT_ID, later).await;
    read(&pool, eli, group, message).await;
    let space = query_as::<_, (String,)>(
        "SELECT legacy_session_id FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(group)
    .fetch_one(&pool)
    .await
    .unwrap()
    .0;
    store::leave_group(&pool, eli, &space).await.unwrap();
    let ben_first = date_mark(&pool, group, ben, message, 3).await;
    let cal_read = date_mark(&pool, group, cal, message, 2).await;
    let ben_later = date_mark(&pool, group, ben, later, 1).await;

    let readers = store::message_readers(&pool, ava, group, message_id, None)
        .await
        .unwrap();
    eprintln!(
        "readers response: {}",
        serde_json::to_string(&readers).unwrap()
    );
    assert_eq!(readers.total, 3);
    // Ben read more later; the message still shows when he first read it.
    assert_eq!(
        readers.readers,
        vec![
            reader(dee, None),
            reader(ben, Some(ben_first)),
            reader(cal, Some(cal_read)),
        ]
    );
    assert!(!readers.readers.iter().any(|r| &r.account_id == fay));

    let limited = store::message_readers(&pool, ava, group, message_id, Some(2))
        .await
        .unwrap();
    assert_eq!(limited.total, 3);
    assert_eq!(limited.readers, readers.readers[..2].to_vec());
    let clamped = store::message_readers(&pool, ava, group, message_id, Some(500))
        .await
        .unwrap();
    assert_eq!(clamped, readers);

    let later_id = message_id_at(&pool, group, later).await;
    let later_readers = store::message_readers(&pool, ava, group, later_id, Some(4))
        .await
        .unwrap();
    assert_eq!(later_readers.total, 1);
    assert_eq!(later_readers.readers, vec![reader(ben, Some(ben_later))]);
}

#[tokio::test]
async fn only_the_author_may_list_readers() {
    let Some(pool) = try_pool().await else { return };
    let (group, people) = group_of(&pool, ["Ava", "Ben", "Cal"]).await;
    let [ava, ben, cal] = &people;
    let message = send(&pool, ava, group, "Synthetic private list").await;
    let message_id = message_id_at(&pool, group, message).await;
    let outsider = account(&pool, "Outsider").await;
    let space = query_as::<_, (String,)>(
        "SELECT legacy_session_id FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(group)
    .fetch_one(&pool)
    .await
    .unwrap()
    .0;
    store::leave_group(&pool, cal, &space).await.unwrap();

    for caller in [ben, cal, &outsider] {
        assert!(
            matches!(
                store::message_readers(&pool, caller, group, message_id, None).await,
                Err(StoreError::Forbidden)
            ),
            "{caller}"
        );
    }
    assert!(matches!(
        store::message_readers(&pool, ava, group, Uuid::now_v7(), None).await,
        Err(StoreError::NotFound)
    ));
    // The message is looked up in the conversation named, not anywhere.
    let other =
        store::create_conversation(&pool, ava, super::group_request(vec![ben.clone()], None))
            .await
            .unwrap()
            .value
            .id;
    assert!(matches!(
        store::message_readers(&pool, ava, other, message_id, None).await,
        Err(StoreError::NotFound)
    ));
}

#[tokio::test]
async fn readers_are_unavailable_above_one_hundred_people() {
    let Some(pool) = try_pool().await else { return };
    let (group, people) = group_of(&pool, ["Ava", "Ben"]).await;
    let [ava, ben] = &people;
    system_account::join(&pool, group).await.unwrap();
    let message = send(&pool, ava, group, "Synthetic crowd check").await;
    let message_id = message_id_at(&pool, group, message).await;
    read(&pool, ben, group, message).await;

    // A hundred people, plus System, still get the list.
    add_people(&pool, group, 98).await;
    let readers = store::message_readers(&pool, ava, group, message_id, Some(4))
        .await
        .unwrap();
    assert_eq!(readers.total, 1);

    add_people(&pool, group, 1).await;
    assert!(matches!(
        store::message_readers(&pool, ava, group, message_id, Some(4)).await,
        Err(StoreError::Conflict {
            code: "readers_unavailable",
            ..
        })
    ));
}

#[tokio::test]
async fn a_reader_whose_mark_was_pruned_has_no_read_time() {
    let Some(pool) = try_pool().await else { return };
    let (group, people) = group_of(&pool, ["Ava", "Ben", "Cal"]).await;
    let [ava, ben, cal] = &people;
    let message = send(&pool, ava, group, "Synthetic old message").await;
    let message_id = message_id_at(&pool, group, message).await;
    read(&pool, ben, group, message).await;
    let later = send(&pool, ava, group, "Synthetic newer message").await;
    read(&pool, ben, group, later).await;
    read(&pool, cal, group, message).await;
    query(
        "UPDATE cloud_chat_read_marks SET read_at = now() - interval '8 days' \
         WHERE conversation_id = $1 AND account_id = $2 AND through_sequence = $3",
    )
    .bind(group)
    .bind(ben)
    .bind(message)
    .execute(&pool)
    .await
    .unwrap();

    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention::READ_MARK_RETENTION_DAYS);
    let pruned = retention::sweep_expired_read_marks(&pool, cutoff)
        .await
        .unwrap();
    assert!(pruned >= 1);

    // Ben's newer mark covers only the newer message, so he has no read time
    // here rather than a later one.
    let readers = store::message_readers(&pool, ava, group, message_id, None)
        .await
        .unwrap();
    assert_eq!(readers.total, 2);
    assert_eq!(readers.readers[0], reader(ben, None));
    assert_eq!(readers.readers[1].account_id, *cal);
    assert!(readers.readers[1].read_at.is_some());
}
