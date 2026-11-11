//! Real sockets over a loopback listener: each close path logs its reason,
//! and a heartbeat ahead of the socket is clamped instead of closing.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

use super::close::{test_sink, CloseReason, CloseRecord};
use super::issue_ticket;
use super::tests::{account_with_device, test_pool};
use crate::auth::session_signals::{SessionSignal, SignalKind};
use crate::chat_sync::cursor::CursorCodec;
use crate::server::ServerState;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Synthetic cursor secret for this test process only.
const TEST_CURSOR_SECRET: &str = "realtime-close-reason-test-cursor-secret-0123456789";
const PROMPT: Duration = Duration::from_secs(5);

struct Harness {
    address: SocketAddr,
    pool: PgPool,
    state: Arc<ServerState>,
    codec: CursorCodec,
    account_id: String,
    device_id: String,
    token_id: String,
}

async fn harness() -> Option<Harness> {
    let pool = test_pool().await?;
    std::env::set_var("KORDI_CHAT_SYNC_CURSOR_SECRET", TEST_CURSOR_SECRET);
    let state = Arc::new(ServerState::new(
        pool.clone(),
        crate::events::EventBus::noop(),
    ));
    let router = crate::server::router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let (account_id, device_id) = account_with_device(&pool).await;
    let session = crate::auth::session::issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    Some(Harness {
        address,
        pool,
        state,
        codec: CursorCodec::new(TEST_CURSOR_SECRET).unwrap(),
        account_id,
        device_id,
        token_id: session.token_id,
    })
}

/// Appends a non-critical event with `payload` to the account's stream.
async fn append_event(harness: &Harness, payload: Value) {
    let mut transaction = harness.pool.begin().await.unwrap();
    crate::chat_sync::store::append_account_hint(
        &mut transaction,
        &harness.account_id,
        "test.hint",
        &payload,
    )
    .await
    .unwrap();
    transaction.commit().await.unwrap();
}

async fn next_json(socket: &mut Socket) -> Value {
    loop {
        let frame = tokio::time::timeout(PROMPT, socket.next())
            .await
            .expect("the server answers")
            .expect("the socket is open")
            .expect("the frame is readable");
        if let Message::Text(body) = frame {
            return serde_json::from_str(&body).unwrap();
        }
    }
}

/// Opens a socket from `stream_seq` and returns it with its connection id.
async fn open(harness: &Harness, stream_seq: i64) -> (Socket, Uuid) {
    let ticket = issue_ticket(
        &harness.pool,
        &harness.account_id,
        &harness.device_id,
        &harness.token_id,
        None,
    )
    .await
    .unwrap();
    let url = format!(
        "ws://{}/v2/chat/realtime?ticket={}",
        harness.address, ticket.plaintext
    );
    let (mut socket, _) = connect_async(url).await.expect("socket connects");
    let connect = json!({
        "type": "connect",
        "protocol_version": crate::chat_sync::PROTOCOL_VERSION,
        "device_id": harness.device_id,
        "cursor": harness.codec.encode(&harness.account_id, stream_seq),
    });
    socket
        .send(Message::Text(connect.to_string()))
        .await
        .unwrap();
    let hello = next_json(&mut socket).await;
    assert_eq!(hello["type"], "hello");
    let connection_id = hello["connection_id"].as_str().unwrap().parse().unwrap();
    (socket, connection_id)
}

async fn heartbeat(socket: &mut Socket, last_applied_seq: i64) {
    let frame = json!({ "type": "heartbeat", "last_applied_seq": last_applied_seq });
    socket.send(Message::Text(frame.to_string())).await.unwrap();
}

async fn closed(connection_id: Uuid) -> CloseRecord {
    test_sink::wait_for(connection_id, PROMPT)
        .await
        .expect("the closed socket logs one record")
}

#[tokio::test]
async fn a_close_frame_and_a_dropped_connection_log_different_reasons() {
    let Some(harness) = harness().await else {
        return;
    };
    let (mut polite, polite_id) = open(&harness, 0).await;
    polite.close(None).await.unwrap();
    assert_eq!(closed(polite_id).await.reason, CloseReason::ClientClosed);

    let (abrupt, abrupt_id) = open(&harness, 0).await;
    drop(abrupt);
    let record = closed(abrupt_id).await;
    assert_eq!(record.reason, CloseReason::ClientGone);
    assert_eq!(record.events_sent, 0);
    assert!(record.log_line().contains("reason=client_gone"));
}

#[tokio::test]
async fn an_unexpected_frame_resyncs_and_logs_invalid_frame() {
    let Some(harness) = harness().await else {
        return;
    };
    let (mut socket, connection_id) = open(&harness, 0).await;
    socket
        .send(Message::Text(r#"{"type":"subscribe"}"#.into()))
        .await
        .unwrap();
    let frame = next_json(&mut socket).await;
    assert_eq!(frame["type"], "resync_required");
    assert_eq!(frame["reason"], "INVALID_CLIENT_FRAME");
    assert_eq!(
        closed(connection_id).await.reason,
        CloseReason::InvalidFrame
    );
}

#[tokio::test]
async fn a_heartbeat_ahead_of_the_socket_is_clamped_instead_of_closing() {
    let Some(harness) = harness().await else {
        return;
    };
    append_event(&harness, json!({ "n": 1 })).await;
    append_event(&harness, json!({ "n": 2 })).await;
    let (mut socket, connection_id) = open(&harness, 0).await;
    for expected in 1..=2 {
        let frame = next_json(&mut socket).await;
        assert_eq!(frame["type"], "event");
        assert_eq!(frame["stream_seq"], expected);
    }

    // The local store also pulled over HTTP, so it reports more than this
    // socket sent. The socket stays open and acknowledges only what it sent.
    heartbeat(&mut socket, 1_000).await;
    let frame = next_json(&mut socket).await;
    assert_eq!(frame["type"], "heartbeat_ack", "got {frame}");
    let (acknowledged, head): (Option<i64>, i64) = query_as(
        "SELECT device.last_ack_seq, head.last_seq FROM cloud_devices device \
         JOIN cloud_chat_user_sync_heads head ON head.account_id = device.account_id \
         WHERE device.device_id = $1",
    )
    .bind(&harness.device_id)
    .fetch_one(&harness.pool)
    .await
    .unwrap();
    assert_eq!(acknowledged, Some(2), "the ack is clamped to what was sent");
    assert!(acknowledged.unwrap() <= head, "never past the stream head");

    // Reporting less than an earlier acknowledgement is still impossible.
    heartbeat(&mut socket, 1).await;
    let frame = next_json(&mut socket).await;
    assert_eq!(frame["type"], "resync_required");
    assert_eq!(frame["reason"], "INVALID_CLIENT_SEQUENCE");
    let record = closed(connection_id).await;
    assert_eq!(record.reason, CloseReason::InvalidSequence);
    assert_eq!(record.events_sent, 2);
}

#[tokio::test]
async fn a_negative_heartbeat_still_closes() {
    let Some(harness) = harness().await else {
        return;
    };
    let (mut socket, connection_id) = open(&harness, 0).await;
    heartbeat(&mut socket, -1).await;
    let frame = next_json(&mut socket).await;
    assert_eq!(frame["reason"], "INVALID_CLIENT_SEQUENCE");
    assert_eq!(
        closed(connection_id).await.reason,
        CloseReason::InvalidSequence
    );
}

#[tokio::test]
async fn an_oversized_event_logs_frame_too_large_and_keeps_its_wire_reason() {
    let Some(harness) = harness().await else {
        return;
    };
    append_event(&harness, json!({ "n": 1 })).await;
    append_event(&harness, json!({ "body": "x".repeat(600 * 1024) })).await;
    let (mut socket, connection_id) = open(&harness, 0).await;
    assert_eq!(next_json(&mut socket).await["stream_seq"], 1);
    let frame = next_json(&mut socket).await;
    assert_eq!(frame["type"], "resync_required");
    assert_eq!(frame["reason"], "CLIENT_TOO_SLOW");
    let record = closed(connection_id).await;
    assert_eq!(record.reason, CloseReason::FrameTooLarge);
    assert_eq!(record.events_sent, 1);
}

#[tokio::test]
async fn a_revocation_signal_logs_session_ended() {
    let Some(harness) = harness().await else {
        return;
    };
    let (mut socket, connection_id) = open(&harness, 0).await;
    harness.state.session_signals().publish(SessionSignal {
        account_id: harness.account_id.clone(),
        device_id: None,
        token_id: Some(harness.token_id.clone()),
        kind: SignalKind::Revoked,
    });
    let ended = tokio::time::timeout(PROMPT, socket.next()).await.unwrap();
    assert!(matches!(
        ended,
        None | Some(Ok(Message::Close(_))) | Some(Err(_))
    ));
    assert_eq!(
        closed(connection_id).await.reason,
        CloseReason::SessionEnded
    );
}
