//! Database tests for rooms of one document held by two processes (two
//! registries without listeners): compaction by a room that lags behind the
//! log, and catch-up across a compaction that deleted the rows it wanted.

use std::collections::HashSet;

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use yrs::sync::{Message, MessageReader, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::{Doc, Transact, Update};

use super::collab_replicas_fixture::*;
use super::db_fixture::*;
use crate::document_shares::collab::{Outgoing, RoomRegistry};

/// The stored compacted sequence and the sequences of the stored rows.
async fn stored_log(pool: &PgPool, attachment_id: &str) -> (i64, Vec<i64>) {
    let (seq,): (i64,) = query_as("SELECT seq FROM cloud_document_collab WHERE attachment_id = $1")
        .bind(attachment_id)
        .fetch_one(pool)
        .await
        .unwrap();
    let rows: Vec<(i64,)> = query_as(
        "SELECT seq FROM cloud_document_collab_updates WHERE attachment_id = $1 ORDER BY seq",
    )
    .bind(attachment_id)
    .fetch_all(pool)
    .await
    .unwrap();
    (seq, rows.into_iter().map(|(seq,)| seq).collect())
}

#[tokio::test]
async fn a_lagging_room_that_compacts_first_keeps_the_later_rows() {
    let Some(f) = fixture().await else { return };
    let id = &f.attachment_id;
    let (first, second) = (
        RoomRegistry::new(f.pool.clone()),
        RoomRegistry::new(f.pool.clone()),
    );
    let lagging = second.join(id).await.unwrap();
    type_into(&lagging, &Doc::new(), "x").await;
    let ahead = first.join(id).await.unwrap();
    let writer = Doc::new();
    type_into(&ahead, &writer, "a").await;
    type_into(&ahead, &writer, "b").await;
    let expected = text_of_update(&ahead.snapshot().await.1);
    assert_eq!(lagging.snapshot().await.0, 1, "the room lags at seq 1");

    second.leave(&lagging, 1, &HashSet::new()).await;
    assert_eq!(stored_log(&f.pool, id).await, (1, vec![2, 3]));
    assert_eq!(stored_text(&f.pool, id).await, expected);

    first.leave(&ahead, 1, &HashSet::new()).await;
    assert_eq!(stored_log(&f.pool, id).await, (3, vec![]));
    assert_eq!(stored_text(&f.pool, id).await, expected);
}

#[tokio::test]
async fn a_lagging_room_that_compacts_after_another_compaction_loses_nothing() {
    let Some(f) = fixture().await else { return };
    let id = &f.attachment_id;
    let (first, second) = (
        RoomRegistry::new(f.pool.clone()),
        RoomRegistry::new(f.pool.clone()),
    );
    let lagging = second.join(id).await.unwrap();
    type_into(&lagging, &Doc::new(), "x").await;
    let ahead = first.join(id).await.unwrap();
    let writer = Doc::new();
    type_into(&ahead, &writer, "a").await;
    type_into(&ahead, &writer, "b").await;
    first.leave(&ahead, 1, &HashSet::new()).await;
    assert_eq!(stored_log(&f.pool, id).await, (3, vec![]));
    let ahead = first.join(id).await.unwrap();
    type_into(&ahead, &writer, "c").await;
    let expected = text_of_update(&ahead.snapshot().await.1);
    for fragment in ["x", "a", "b", "c"] {
        assert!(expected.contains(fragment), "{expected}");
    }

    // Compacting at seq 1 must neither replace the newer state nor touch row 4.
    second.leave(&lagging, 1, &HashSet::new()).await;
    assert_eq!(stored_log(&f.pool, id).await, (3, vec![4]));
    assert_eq!(stored_text(&f.pool, id).await, expected);
}

#[tokio::test]
async fn catching_up_across_a_compaction_applies_the_compacted_state() {
    let Some(f) = fixture().await else { return };
    let id = &f.attachment_id;
    let (first, second) = (
        RoomRegistry::new(f.pool.clone()),
        RoomRegistry::new(f.pool.clone()),
    );
    let behind = second.join(id).await.unwrap();
    let mut frames = behind.subscribe();
    let ahead = first.join(id).await.unwrap();
    let writer = Doc::new();
    type_into(&ahead, &writer, "ab").await;
    type_into(&ahead, &writer, "cd").await;
    first.leave(&ahead, 1, &HashSet::new()).await;
    assert_eq!(
        stored_log(&f.pool, id).await,
        (2, vec![]),
        "the rows the room wants are gone"
    );

    behind.catch_up().await;
    let (seq, state) = behind.snapshot().await;
    assert_eq!(seq, 2);
    assert_eq!(text_of_update(&state), "abcd");

    // The room's sockets get the change, sent from the server (connection 0).
    let Ok(Outgoing::Frame { from: 0, frame }) = frames.try_recv() else {
        panic!("catch-up broadcasts what the document took");
    };
    let mut decoder = DecoderV1::new(yrs::encoding::read::Cursor::new(frame.as_slice()));
    let messages: Vec<Message> = MessageReader::new(&mut decoder)
        .map(Result::unwrap)
        .collect();
    let [Message::Sync(SyncMessage::Update(delta))] = messages.as_slice() else {
        panic!("one sync update: {messages:?}");
    };
    let client = Doc::new();
    client
        .transact_mut()
        .apply_update(Update::decode_v1(delta).unwrap())
        .unwrap();
    assert_eq!(text_of(&client), "abcd");
}

#[tokio::test]
async fn the_periodic_catch_up_reads_every_room_behind_the_log() {
    let Some(f) = fixture().await else { return };
    let id = &f.attachment_id;
    let (first, second) = (
        RoomRegistry::new(f.pool.clone()),
        RoomRegistry::new(f.pool.clone()),
    );
    let behind = second.join(id).await.unwrap();
    let ahead = first.join(id).await.unwrap();
    type_into(&ahead, &Doc::new(), "missed").await;
    assert_eq!(behind.snapshot().await.0, 0);

    second.catch_up_all().await;
    let (seq, state) = behind.snapshot().await;
    assert_eq!(seq, 1);
    assert_eq!(text_of_update(&state), "missed");
}

#[tokio::test]
async fn a_change_waiting_for_missing_dependencies_is_stored_as_received() {
    let Some(f) = fixture().await else { return };
    let id = &f.attachment_id;
    let (first, second) = (
        RoomRegistry::new(f.pool.clone()),
        RoomRegistry::new(f.pool.clone()),
    );
    let behind = second.join(id).await.unwrap();
    let ahead = first.join(id).await.unwrap();
    let writer = Doc::new();
    type_into(&ahead, &writer, "depends ").await;

    // The next change builds on the first, which `behind` has not read: its
    // document holds it back, and the catch-up that resolves it stores nothing.
    let next = update_frame(append_text(&writer, "on it"));
    behind.handle(1, &next, &mut HashSet::new()).await.unwrap();
    assert_eq!(text_of_update(&behind.snapshot().await.1), "depends on it");
    assert_eq!(stored_text(&f.pool, id).await, "depends on it");
}
