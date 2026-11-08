use super::*;
use crate::canonical_sessions::{
    open_or_create_session_in_db, select_message, upsert_message_in_db,
    AppendCanonicalMessageRequest, OpenCanonicalSessionRequest,
};

const SESSION: &str = "session:group:slot-prune";
const SLOT_ID: &str = "msg:cloud-agent-processing:msg:ui:request:acct_me";

fn open_group(conn: &Connection) {
    open_or_create_session_in_db(
        conn,
        OpenCanonicalSessionRequest {
            id: Some(SESSION.to_string()),
            kind: "group".to_string(),
            title: Some("Slot prune".to_string()),
            status: None,
            created_by_identity_id: "human:me".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: Vec::new(),
            metadata: None,
        },
    )
    .expect("open group");
}

fn sync_wire(conn: &Connection, wire_id: &str, sequence: i64) {
    conn.execute(
        "INSERT INTO chat_sync_messages (
            account_id, message_id, conversation_id, conversation_sequence,
            version, snapshot_json, updated_at_ms
         ) VALUES ('acct_me', ?1, 'conversation-slot', ?2, 1, '{}', ?2)",
        params![wire_id, sequence],
    )
    .expect("store durable wire copy");
}

/// The owner's Mac writes the agent's slot under one stable id: first with
/// its own source, then with each server copy it receives.
fn slot(source_event_id: &str, state: &str, created_at_ms: i64) -> AppendCanonicalMessageRequest {
    AppendCanonicalMessageRequest {
        id: Some(SLOT_ID.to_string()),
        session_id: SESSION.to_string(),
        sender_identity_id: "agent:cloud:acct_me".to_string(),
        sender_role: "owned-agent".to_string(),
        message_kind: "agent-turn".to_string(),
        content_text: if state == "complete" { "Done" } else { "" }.to_string(),
        content: Some(serde_json::json!({
            "deliveryState": state,
            "requestId": "msg:ui:request",
        })),
        parent_message_id: Some("msg:ui:request".to_string()),
        delegated_exchange_id: None,
        status: Some(state.to_string()),
        created_at_ms: Some(created_at_ms),
        source_transport: Some("cloud-group-agent".to_string()),
        source_event_id: Some(source_event_id.to_string()),
    }
}

fn prune(conn: &mut Connection) -> Vec<String> {
    super::super::lifecycle::prune_missing_cloud_messages_in_db(conn, "acct_me")
        .expect("prune missing cloud messages")
}

#[test]
fn a_running_agent_slot_survives_pruning_and_the_reply_keeps_its_place() {
    let mut conn = test_conn();
    seed_identity(&conn);
    open_group(&conn);
    upsert_message_in_db(
        &conn,
        slot(&format!("cloud-group-agent:{SLOT_ID}"), "processing", 2_000),
    )
    .expect("write local waiting slot");
    assert!(
        prune(&mut conn).is_empty(),
        "a local id has no Cloud copy yet"
    );

    // The send response is applied before the sync stream stores its copy.
    upsert_message_in_db(
        &conn,
        slot("cloud-group-agent:wire-waiting", "processing", 2_000),
    )
    .expect("apply the published waiting row");
    assert!(
        prune(&mut conn).is_empty(),
        "a fresh row waits for its copy"
    );
    sync_wire(&conn, "wire-waiting", 18);

    let reply = upsert_message_in_db(
        &conn,
        slot("cloud-group-agent:msg:cloud-agent:turn", "complete", 4_000),
    )
    .expect("complete the reply");
    assert_eq!(reply.created_at_ms, 2_000);
    assert_eq!(reply.content_text, "Done");
}

#[test]
fn rows_missing_from_durable_history_are_pruned_after_the_grace_period() {
    let mut conn = test_conn();
    seed_identity(&conn);
    open_group(&conn);
    upsert_message_in_db(
        &conn,
        slot("cloud-group-agent:wire-gone", "complete", 2_000),
    )
    .expect("write a reply the server no longer has");
    assert!(prune(&mut conn).is_empty());

    let later = select_message(&conn, SLOT_ID)
        .unwrap()
        .unwrap()
        .updated_at_ms
        + 1;
    let deleted = super::super::lifecycle::prune_missing_cloud_messages_updated_before(
        &mut conn, "acct_me", later,
    )
    .expect("prune old rows");
    assert_eq!(deleted, vec![SLOT_ID.to_string()]);

    // A row under this Mac's own id is never treated as a missing Cloud copy.
    upsert_message_in_db(
        &conn,
        slot(&format!("cloud-group-agent:{SLOT_ID}"), "processing", 3_000),
    )
    .expect("write local waiting slot");
    let deleted = super::super::lifecycle::prune_missing_cloud_messages_updated_before(
        &mut conn,
        "acct_me",
        i64::MAX,
    )
    .expect("prune old rows");
    assert!(deleted.is_empty());
}
