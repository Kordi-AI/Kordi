//! A session deleted on this device leaves the account a member of its
//! conversation on the server, so the stream keeps naming that conversation.
//! The mirror cannot tell such a conversation from one missing by mistake: it
//! rejects the whole batch with a stable code, and a bootstrap restores the row.

use super::*;
use serde_json::json;

const ACCOUNT: &str = "acct_owner";
const CODE: &str = "CHAT_SYNC_UNKNOWN_CONVERSATION";

fn conversation(version: i64) -> Value {
    json!({
        "id": "conversation-1",
        "kind": "group",
        "legacy_session_id": "session-1",
        "version": version,
        "latest_message_sequence": 3,
        "members": [
            { "account_id": ACCOUNT, "last_delivered_sequence": 1, "last_read_sequence": 1 },
            { "account_id": "acct_peer", "last_delivered_sequence": 3, "last_read_sequence": 3 }
        ]
    })
}

fn bootstrap(cursor: &str, last_stream_seq: i64) -> ChatSyncApplyRequest {
    ChatSyncApplyRequest {
        account_id: ACCOUNT.to_string(),
        bootstrap: true,
        cursor: Some(cursor.to_string()),
        last_stream_seq: Some(last_stream_seq),
        conversations: vec![conversation(last_stream_seq + 1)],
        messages: vec![],
        events: vec![],
    }
}

fn batch(events: Vec<Value>) -> ChatSyncApplyRequest {
    let last = events.last().and_then(|event| event["stream_seq"].as_i64());
    ChatSyncApplyRequest {
        account_id: ACCOUNT.to_string(),
        bootstrap: false,
        cursor: last.map(|sequence| format!("cursor-{sequence}")),
        last_stream_seq: last,
        conversations: vec![],
        messages: vec![],
        events,
    }
}

fn event(event_type: &str, stream_seq: i64, conversation_id: &str, payload: Value) -> Value {
    json!({
        "protocol_version": 2,
        "type": event_type,
        "event_id": format!("event-{stream_seq}"),
        "stream_seq": stream_seq,
        "critical": true,
        "conversation_id": conversation_id,
        "payload": payload
    })
}

fn cursor_event(event_type: &str, stream_seq: i64, read: i64) -> Value {
    let cursor = json!({
        "account_id": ACCOUNT,
        "last_delivered_sequence": read,
        "last_read_sequence": read
    });
    event(
        event_type,
        stream_seq,
        "conversation-1",
        json!({ "cursor": cursor }),
    )
}

fn preferences_event(stream_seq: i64) -> Value {
    event(
        "conversation.preferences.updated",
        stream_seq,
        "conversation-1",
        json!({ "preferences": { "muted": true } }),
    )
}

fn other_conversation_created(stream_seq: i64) -> Value {
    let created = json!({ "id": "conversation-2", "kind": "direct", "version": 1 });
    event(
        "conversation.created",
        stream_seq,
        "conversation-2",
        json!({ "conversation": created }),
    )
}

fn stored_cursor(conn: &Connection) -> (String, i64) {
    conn.query_row(
        "SELECT cursor, last_stream_seq FROM chat_sync_state WHERE account_id = ?1",
        [ACCOUNT],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .unwrap()
}

fn conversation_ids(conn: &Connection) -> Vec<String> {
    load_state(conn, ACCOUNT)
        .unwrap()
        .conversations
        .iter()
        .filter_map(|conversation| conversation["id"].as_str().map(str::to_string))
        .collect()
}

fn viewer_last_read_sequence(conn: &Connection) -> Option<i64> {
    let state = load_state(conn, ACCOUNT).unwrap();
    let conversation = state
        .conversations
        .iter()
        .find(|conversation| conversation["id"] == "conversation-1")?;
    conversation["members"]
        .as_array()?
        .iter()
        .find(|member| member["account_id"] == ACCOUNT)?["last_read_sequence"]
        .as_i64()
}

/// Bootstraps the conversation, then deletes its session on this device.
fn mirror_with_deleted_session() -> Connection {
    let mut conn = test_support::test_connection();
    apply_on_connection(&mut conn, bootstrap("cursor-0", 0)).unwrap();
    let deleted = json!({
        "protocol_version": 2,
        "type": "session.deleted",
        "stream_seq": 1,
        "critical": true,
        "payload": { "sessionId": "session-1" }
    });
    apply_on_connection(&mut conn, batch(vec![deleted])).unwrap();
    assert!(conversation_ids(&conn).is_empty());
    assert_eq!(stored_cursor(&conn), ("cursor-1".to_string(), 1));
    conn
}

fn assert_rejected_without_commit(conn: &mut Connection, events: Vec<Value>) {
    let error = apply_on_connection(conn, batch(events)).unwrap_err();
    assert!(error.starts_with(CODE), "unexpected error: {error}");
    assert_eq!(stored_cursor(conn), ("cursor-1".to_string(), 1));
    assert!(
        conversation_ids(conn).is_empty(),
        "the batch must not commit"
    );
}

#[test]
fn a_cursor_event_for_a_session_deleted_on_this_device_fails_the_batch_with_a_stable_code() {
    let mut conn = mirror_with_deleted_session();
    assert_rejected_without_commit(
        &mut conn,
        vec![
            cursor_event("read_cursor.updated", 2, 3),
            other_conversation_created(3),
        ],
    );
}

#[test]
fn every_conversation_projection_event_reports_the_unknown_conversation_code() {
    for failing in [
        cursor_event("read_cursor.updated", 3, 3),
        cursor_event("delivery_cursor.updated", 3, 3),
        preferences_event(3),
    ] {
        let mut conn = mirror_with_deleted_session();
        // The event applied before the failing one is rolled back with it.
        assert_rejected_without_commit(&mut conn, vec![other_conversation_created(2), failing]);
    }
}

#[test]
fn a_bootstrap_restores_the_conversation_and_later_cursor_events_apply() {
    let mut conn = mirror_with_deleted_session();
    assert_rejected_without_commit(&mut conn, vec![cursor_event("read_cursor.updated", 2, 3)]);

    apply_on_connection(&mut conn, bootstrap("cursor-5", 5)).unwrap();
    assert_eq!(stored_cursor(&conn), ("cursor-5".to_string(), 5));
    assert_eq!(conversation_ids(&conn), ["conversation-1"]);
    assert_eq!(viewer_last_read_sequence(&conn), Some(1));

    apply_on_connection(
        &mut conn,
        batch(vec![cursor_event("read_cursor.updated", 6, 3)]),
    )
    .unwrap();
    assert_eq!(viewer_last_read_sequence(&conn), Some(3));
    assert_eq!(stored_cursor(&conn), ("cursor-6".to_string(), 6));
}

#[test]
fn a_cursor_event_for_a_held_conversation_applies() {
    let mut conn = test_support::test_connection();
    apply_on_connection(&mut conn, bootstrap("cursor-0", 0)).unwrap();
    apply_on_connection(
        &mut conn,
        batch(vec![cursor_event("read_cursor.updated", 1, 2)]),
    )
    .unwrap();
    assert_eq!(viewer_last_read_sequence(&conn), Some(2));
    assert_eq!(stored_cursor(&conn), ("cursor-1".to_string(), 1));
}
