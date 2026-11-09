//! Database tests for one document edited through several server instances
//! at once: concurrent typing, catch-up without notifications, a storage
//! failure, and awareness relayed between instances.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use yrs::sync::{Awareness, Message};
use yrs::Doc;

use super::collab_replicas_fixture::*;
use super::db_fixture::*;

#[tokio::test]
async fn editors_on_two_instances_converge_while_typing_at_once() {
    let Some(f) = fixture().await else { return };
    let one = instance(true).await;
    let two = instance(true).await;
    let mut alex = Peer::join(&f, &one, &f.owner_token, Doc::new()).await;
    let mut priya = Peer::join(&f, &two, &f.member_token, Doc::new()).await;

    // The very first edit of the document lands on both instances at once.
    tokio::join!(alex.type_text("[a0]"), priya.type_text("[p0]"));
    let mut fragments = vec!["[a0]".to_string(), "[p0]".to_string()];
    for round in 1..=15 {
        let (a, p) = (format!("[a{round}]"), format!("[p{round}]"));
        tokio::join!(alex.type_text(&a), priya.type_text(&p));
        fragments.extend([a, p]);
    }
    let complete = |fragments: &[String], text: &str| {
        fragments
            .iter()
            .all(|fragment| text.matches(fragment.as_str()).count() == 1)
    };
    alex.sync_until(|text| complete(&fragments, text)).await;
    priya.sync_until(|text| complete(&fragments, text)).await;
    assert_eq!(alex.text(), priya.text());

    // Once both are idle, a change only one side makes reaches the other
    // through the notification listener alone.
    alex.type_text("[a-last]").await;
    fragments.push("[a-last]".to_string());
    alex.sync_until(|text| complete(&fragments, text)).await;
    priya.sync_until(|text| complete(&fragments, text)).await;
    assert_eq!(alex.text(), priya.text());
    assert_eq!(stored_text(&f.pool, &f.attachment_id).await, alex.text());
    // Neither socket was closed along the way.
    alex.assert_open().await;
    priya.assert_open().await;
}

async fn stored_seqs(pool: &PgPool, attachment_id: &str) -> Vec<i64> {
    query_as::<_, (i64,)>(
        "SELECT seq FROM cloud_document_collab_updates WHERE attachment_id = $1 ORDER BY seq",
    )
    .bind(attachment_id)
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|(seq,)| seq)
    .collect()
}

#[tokio::test]
async fn a_writer_that_finds_rows_in_between_catches_up_without_notifications() {
    let Some(f) = fixture().await else { return };
    let one = instance(false).await;
    let two = instance(false).await;
    let mut alex = Peer::join(&f, &one, &f.owner_token, Doc::new()).await;
    let mut priya = Peer::join(&f, &two, &f.member_token, Doc::new()).await;

    alex.type_text("alpha ").await;
    alex.pump_for(Duration::from_millis(200)).await;
    assert!(
        priya.stays_quiet(Duration::from_millis(400)).await,
        "no listener tells the second instance"
    );
    // Priya's change is stored after Alex's row, which her room then reads.
    priya.type_text("beta ").await;
    priya
        .sync_until(|text| text.contains("alpha ") && text.contains("beta "))
        .await;
    alex.type_text("gamma ").await;
    alex.sync_until(|text| text.contains("beta ")).await;

    assert_eq!(stored_seqs(&f.pool, &f.attachment_id).await, vec![1, 2, 3]);
    let stored = stored_text(&f.pool, &f.attachment_id).await;
    for fragment in ["alpha ", "beta ", "gamma "] {
        assert_eq!(stored.matches(fragment).count(), 1, "{stored}");
    }
    assert_eq!(stored, alex.text());
}

/// Makes every insert of one document's updates fail until removed.
struct FailingInserts {
    name: String,
}

impl FailingInserts {
    async fn install(pool: &PgPool, attachment_id: &str) -> Self {
        let name = format!("kordi_test_fail_collab_{}", uuid::Uuid::new_v4().simple());
        query(&format!(
            "CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS \
             $$ BEGIN RAISE EXCEPTION 'storage failure for the test'; END $$"
        ))
        .execute(pool)
        .await
        .unwrap();
        query(&format!(
            "CREATE TRIGGER {name} BEFORE INSERT ON cloud_document_collab_updates \
             FOR EACH ROW WHEN (NEW.attachment_id = '{attachment_id}') EXECUTE FUNCTION {name}()"
        ))
        .execute(pool)
        .await
        .unwrap();
        Self { name }
    }

    async fn remove(self, pool: &PgPool) {
        let name = self.name;
        query(&format!(
            "DROP TRIGGER {name} ON cloud_document_collab_updates"
        ))
        .execute(pool)
        .await
        .unwrap();
        query(&format!("DROP FUNCTION {name}()"))
            .execute(pool)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn a_storage_failure_resets_the_room_and_the_resent_change_is_kept() {
    let Some(f) = fixture().await else { return };
    let server = instance(false).await;
    let mut alex = Peer::join(&f, &server, &f.owner_token, Doc::new()).await;
    let mut priya = Peer::join(&f, &server, &f.member_token, Doc::new()).await;
    alex.type_text("kept ").await;
    priya.sync_until(|text| text == "kept ").await;

    // A connection that keeps the room loaded after its sockets close.
    let rooms = server.state.document_rooms();
    let held = rooms.join(&f.attachment_id).await.unwrap();
    let failing = FailingInserts::install(&f.pool, &f.attachment_id).await;
    alex.type_text("resent ").await;
    assert_eq!(alex.close_code().await, 1013, "the sender tries again");
    assert_eq!(priya.close_code().await, 1013, "so does everyone else");
    assert!(held.is_poisoned());

    // The registry never hands out the discarded room.
    let fresh = rooms.join(&f.attachment_id).await.unwrap();
    assert!(!Arc::ptr_eq(&held, &fresh));
    assert!(!fresh.is_poisoned());
    assert_eq!(text_of_update(&fresh.snapshot().await.1), "kept ");
    failing.remove(&f.pool).await;

    // Reconnecting, the editors' sync sends the change again.
    let alex = Peer::join(&f, &server, &f.owner_token, alex.doc.clone()).await;
    let mut priya = Peer::join(&f, &server, &f.member_token, priya.doc.clone()).await;
    priya.sync_until(|text| text.contains("resent ")).await;
    assert_eq!(alex.text(), "kept resent ");
    assert_eq!(stored_text(&f.pool, &f.attachment_id).await, alex.text());
    rooms.leave(&held, 0, &HashSet::new()).await;
    rooms.leave(&fresh, 0, &HashSet::new()).await;
}

#[tokio::test]
async fn awareness_reaches_editors_on_the_other_instance() {
    let Some(f) = fixture().await else { return };
    let one = instance(true).await;
    let two = instance(true).await;
    let alex_doc = Doc::new();
    let alex_id = alex_doc.client_id();
    let mut alex = Peer::join(&f, &one, &f.owner_token, alex_doc.clone()).await;
    let awareness = Awareness::new(alex_doc);
    awareness
        .set_local_state(json!({"user": {"name": "Alex"}}))
        .unwrap();
    alex.send(Message::Awareness(awareness.update().unwrap()))
        .await;

    // The second instance loads the room, asks, and gets Alex's state.
    let mut priya = Peer::join(&f, &two, &f.member_token, Doc::new()).await;
    let shows = |name: &'static str| {
        move |update: &yrs::sync::AwarenessUpdate| {
            update
                .clients
                .get(&alex_id)
                .is_some_and(|entry| entry.json.contains(name))
        }
    };
    priya.awareness_until(shows("\"Alex\"")).await;

    // A later change travels as it happens.
    awareness
        .set_local_state(json!({"user": {"name": "Alex Morgan"}}))
        .unwrap();
    alex.send(Message::Awareness(awareness.update().unwrap()))
        .await;
    priya.awareness_until(shows("Alex Morgan")).await;
    assert!(
        alex.stays_quiet(Duration::from_millis(500)).await,
        "an instance ignores its own notifications"
    );

    // Leaving clears Alex's state on the other instance too.
    alex.close().await;
    priya
        .awareness_until(|update| {
            update
                .clients
                .get(&alex_id)
                .is_some_and(|entry| entry.json.as_ref() == "null")
        })
        .await;
}
