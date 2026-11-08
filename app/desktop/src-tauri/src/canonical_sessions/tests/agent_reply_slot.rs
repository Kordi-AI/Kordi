use super::*;

const SESSION: &str = "session:group:reply-slot";
const SLOT_ID: &str = "msg:cloud-agent-processing:msg:ui:request:acct_owner";

fn open_group(conn: &Connection) {
    open_or_create_session_in_db(
        conn,
        OpenCanonicalSessionRequest {
            id: Some(SESSION.to_string()),
            kind: "group".to_string(),
            title: Some("Reply slot".to_string()),
            status: None,
            created_by_identity_id: "human:acct_owner".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: Vec::new(),
            metadata: None,
        },
    )
    .expect("open reply slot group");
}

fn seed_wire_row(conn: &Connection, wire_id: &str, sequence: i64) {
    conn.execute(
        "INSERT OR IGNORE INTO chat_sync_conversations(
             account_id, conversation_id, client_session_id, version,
             snapshot_json, updated_at_ms
         ) VALUES ('acct_viewer', 'conversation-reply-slot', ?1, 1, '{}', 1)",
        rusqlite::params![SESSION],
    )
    .expect("seed conversation");
    conn.execute(
        "INSERT INTO chat_sync_messages(
             account_id, message_id, conversation_id, conversation_sequence,
             version, snapshot_json, updated_at_ms
         ) VALUES ('acct_viewer', ?1, 'conversation-reply-slot', ?2, 1, '{}', ?2)",
        rusqlite::params![wire_id, sequence],
    )
    .expect("seed wire row");
}

fn person_message(id: &str, wire_id: &str, created_at_ms: i64) -> AppendCanonicalMessageRequest {
    AppendCanonicalMessageRequest {
        id: Some(id.to_string()),
        session_id: SESSION.to_string(),
        sender_identity_id: "human:acct_peer".to_string(),
        sender_role: "person".to_string(),
        message_kind: "text".to_string(),
        content_text: id.to_string(),
        content: None,
        parent_message_id: None,
        delegated_exchange_id: None,
        status: Some("received".to_string()),
        created_at_ms: Some(created_at_ms),
        source_transport: Some("cloud-group".to_string()),
        source_event_id: Some(format!("cloud-group:{wire_id}")),
    }
}

/// The desktop maps the waiting row and the reply onto one stable slot id.
fn agent_row(
    wire_id: &str,
    state: &str,
    text: &str,
    created_at_ms: i64,
) -> AppendCanonicalMessageRequest {
    let status = if state == "complete" {
        "received"
    } else {
        state
    };
    AppendCanonicalMessageRequest {
        id: Some(SLOT_ID.to_string()),
        session_id: SESSION.to_string(),
        sender_identity_id: "agent:cloud:acct_owner".to_string(),
        sender_role: "external-agent".to_string(),
        message_kind: "agent-turn".to_string(),
        content_text: text.to_string(),
        content: Some(serde_json::json!({
            "deliveryState": state,
            "requestId": "msg:ui:request",
            "replyToMessageId": "msg:ui:request",
        })),
        parent_message_id: Some("msg:ui:request".to_string()),
        delegated_exchange_id: None,
        status: Some(status.to_string()),
        created_at_ms: Some(created_at_ms),
        source_transport: Some("cloud-group-agent".to_string()),
        source_event_id: Some(format!("cloud-group-agent:{wire_id}")),
    }
}

fn seeded_group() -> Connection {
    let conn = test_conn();
    open_group(&conn);
    seed_wire_row(&conn, "wire-request", 17);
    seed_wire_row(&conn, "wire-waiting", 18);
    seed_wire_row(&conn, "wire-unrelated", 19);
    seed_wire_row(&conn, "wire-reply", 20);
    upsert_message_in_db(
        &conn,
        person_message("msg:ui:request", "wire-request", 1_000),
    )
    .expect("append request");
    conn
}

fn timeline(conn: &Connection) -> Vec<(String, i64, i64)> {
    let mut messages = commands::load_state_from_db(conn)
        .expect("load state")
        .messages
        .into_iter()
        .filter(|message| message.session_id == SESSION)
        .map(|message| (message.id, message.created_at_ms, message.sequence_num))
        .collect::<Vec<_>>();
    messages.sort_by_key(|(_, created_at_ms, sequence_num)| (*created_at_ms, *sequence_num));
    messages
}

fn ids(timeline: &[(String, i64, i64)]) -> Vec<&str> {
    timeline.iter().map(|(id, _, _)| id.as_str()).collect()
}

#[test]
fn live_reply_keeps_the_waiting_row_slot() {
    let conn = seeded_group();
    upsert_message_in_db(&conn, agent_row("wire-waiting", "processing", "", 2_000))
        .expect("append waiting row");
    upsert_message_in_db(
        &conn,
        person_message("msg:ui:unrelated", "wire-unrelated", 3_000),
    )
    .expect("append unrelated message");
    let reply = upsert_message_in_db(&conn, agent_row("wire-reply", "complete", "Done", 4_000))
        .expect("complete reply");

    assert_eq!(reply.content_text, "Done");
    assert_eq!((reply.created_at_ms, reply.sequence_num), (2_000, 18));
    assert_eq!(
        ids(&timeline(&conn)),
        ["msg:ui:request", SLOT_ID, "msg:ui:unrelated"],
    );
}

#[test]
fn replayed_waiting_row_moves_its_reply_to_the_live_slot() {
    let live = seeded_group();
    upsert_message_in_db(&live, agent_row("wire-waiting", "processing", "", 2_000)).unwrap();
    upsert_message_in_db(
        &live,
        person_message("msg:ui:unrelated", "wire-unrelated", 3_000),
    )
    .unwrap();
    upsert_message_in_db(&live, agent_row("wire-reply", "complete", "Done", 4_000)).unwrap();

    // Newest history pages can replay the reply before its waiting row.
    let replayed = seeded_group();
    upsert_message_in_db(
        &replayed,
        agent_row("wire-reply", "complete", "Done", 4_000),
    )
    .unwrap();
    upsert_message_in_db(
        &replayed,
        person_message("msg:ui:unrelated", "wire-unrelated", 3_000),
    )
    .unwrap();
    let after_waiting = upsert_message_in_db(
        &replayed,
        agent_row("wire-waiting", "processing", "", 2_000),
    )
    .expect("replay waiting row");

    assert_eq!(after_waiting.status, "received");
    assert_eq!(after_waiting.content_text, "Done");
    assert_eq!(
        (after_waiting.created_at_ms, after_waiting.sequence_num),
        (2_000, 18)
    );
    assert_eq!(timeline(&replayed), timeline(&live));
    assert_eq!(
        ids(&timeline(&replayed)),
        ["msg:ui:request", SLOT_ID, "msg:ui:unrelated"],
    );
}

#[test]
fn reply_without_a_waiting_row_keeps_its_own_place() {
    let conn = seeded_group();
    upsert_message_in_db(
        &conn,
        person_message("msg:ui:unrelated", "wire-unrelated", 3_000),
    )
    .unwrap();
    upsert_message_in_db(&conn, agent_row("wire-reply", "complete", "Done", 4_000)).unwrap();
    // A later pending replay never moves the reply.
    let replayed = upsert_message_in_db(&conn, agent_row("wire-waiting", "processing", "", 5_000))
        .expect("replay later waiting row");

    assert_eq!((replayed.created_at_ms, replayed.sequence_num), (4_000, 20));
    assert_eq!(
        ids(&timeline(&conn)),
        ["msg:ui:request", "msg:ui:unrelated", SLOT_ID],
    );
}
