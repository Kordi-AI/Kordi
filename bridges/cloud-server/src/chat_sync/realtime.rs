//! Durable realtime transport for the canonical chat protocol.
//!
//! The socket never owns canonical state. It authenticates with a single-use
//! ticket, catches up from the PostgreSQL sync stream, and reads that stream
//! again whenever this replica's notification listener wakes the account.
//! A backstop read repairs a dropped notification or listener restart.
//!
//! Sign-out, device revocation, and account deletion reach the socket as a
//! session signal and close it at once. A jittered ~30 s recheck backs that
//! up, the socket closes at its session's known expiry, and short database
//! outages delay work instead of closing sockets.
//!
//! Every socket ends with one log line naming why it closed (see [`close`]).

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header::ORIGIN, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::StreamExt;
use serde::Deserialize;
use tokio::sync::watch;
use tokio::time::Instant;
use uuid::Uuid;

use crate::auth::session_signals::{SessionSignalSubscription, SignalVerdict};
use crate::chat_sync::cursor::CursorCodec;
use crate::chat_sync::PROTOCOL_VERSION;
use crate::server::ServerState;

mod admission;
mod close;
mod delivery;
mod frames;
pub(crate) mod retry;
mod session;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_admission;
#[cfg(test)]
mod tests_close;
#[cfg(test)]
mod tests_session;
#[cfg(test)]
mod tests_socket;
mod ticket;
mod wake;

pub(crate) use admission::ticket_refusal;
pub use admission::{TicketAdmission, REALTIME_TICKETS_PER_SECOND_ENV, REALTIME_TICKET_BURST_ENV};
use close::{log_close, CloseReason, CloseRecord};
use delivery::{
    persist_device_ack, Delivery, DeliveryEnd, CATCH_UP_SPREAD, REPAIR_WITHOUT_LISTENER,
};
use frames::{
    receive_connect, reject_connect, resync_and_close, send_close, send_json, send_message,
    ClientFrame, HeartbeatAckFrame, HelloFrame,
};
use session::{check_connection, GuardStep, SessionCheck, SessionGuard};
use ticket::{consume_ticket, ConsumedRealtimeTicket};
pub use ticket::{issue_ticket, IssuedRealtimeTicket, TicketError};
pub(crate) use wake::{spawn_wake_listener, ChatSyncWakeHub, ListenerStatus};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(65);
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CLIENT_FRAME_BYTES: usize = 64 * 1024;
const MAX_SERVER_FRAME_BYTES: usize = 512 * 1024;
const MAX_UNACKNOWLEDGED_EVENTS: i64 = 1_000;
/// A ticket without a session, issued by an older replica during a rolling
/// update, can only be checked against its device. Its socket is closed after
/// this long so the client reconnects with a session-bound ticket.
const LEGACY_TICKET_SOCKET_LIFETIME: Duration = Duration::from_secs(5 * 60);

fn cursor_codec() -> Option<CursorCodec> {
    std::env::var("KORDI_CHAT_SYNC_CURSOR_SECRET")
        .ok()
        .and_then(|secret| CursorCodec::new(secret).ok())
}

#[derive(Deserialize)]
pub struct RealtimeQuery {
    ticket: String,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
    Query(query): Query<RealtimeQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(codec) = cursor_codec() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let ticket = match consume_ticket(state.db_pool(), &query.ticket).await {
        Ok(ticket) => ticket,
        Err(TicketError::InvalidTicket) => return StatusCode::UNAUTHORIZED.into_response(),
        Err(TicketError::OriginNotAllowed) => return StatusCode::FORBIDDEN.into_response(),
        Err(TicketError::Database(error)) => {
            eprintln!("[chat-realtime] consume ticket: {error}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let request_origin = headers
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(ToString::to_string);
    if ticket.allowed_origin != request_origin {
        return StatusCode::FORBIDDEN.into_response();
    }

    // Subscribe before checking, so a revocation that commits after the
    // check still reaches the socket.
    let signals = state.session_signals().subscribe(
        &ticket.account_id,
        &ticket.device_id,
        ticket.session_token_id.as_deref(),
    );
    let expires_at = match check_connection(state.db_pool(), &ticket, state.admission()).await {
        SessionCheck::Active { expires_at } => expires_at,
        SessionCheck::Inactive => return StatusCode::FORBIDDEN.into_response(),
        SessionCheck::Unavailable => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let opened_at = Instant::now();
    let guard = SessionGuard::new(
        opened_at,
        expires_at,
        legacy_ticket_deadline(&ticket, opened_at),
    );
    ws.max_message_size(MAX_CLIENT_FRAME_BYTES)
        .max_frame_size(MAX_CLIENT_FRAME_BYTES)
        .on_upgrade(move |socket| {
            run_socket(
                socket,
                state,
                SocketAuth {
                    ticket,
                    guard,
                    signals,
                },
                codec,
            )
        })
}

/// When a socket opened at `opened_at` with `ticket` must close regardless of
/// revalidation: only sockets opened with a legacy ticket have a deadline.
fn legacy_ticket_deadline(ticket: &ConsumedRealtimeTicket, opened_at: Instant) -> Option<Instant> {
    ticket
        .session_token_id
        .is_none()
        .then(|| opened_at + LEGACY_TICKET_SOCKET_LIFETIME)
}

/// The authorization state a socket carries from the upgrade request.
struct SocketAuth {
    ticket: ConsumedRealtimeTicket,
    guard: SessionGuard,
    signals: SessionSignalSubscription,
}

/// Resolves when the listener status changes; never, if its hub is gone.
async fn listener_changed(status: &mut watch::Receiver<ListenerStatus>) -> ListenerStatus {
    if status.changed().await.is_err() {
        std::future::pending::<()>().await;
    }
    *status.borrow_and_update()
}

async fn run_socket(
    socket: WebSocket,
    state: Arc<ServerState>,
    auth: SocketAuth,
    codec: CursorCodec,
) {
    let opened_at = Instant::now();
    let connection_id = Uuid::now_v7();
    let mut events_sent = 0;
    let reason = serve_socket(
        socket,
        &state,
        auth,
        &codec,
        connection_id,
        &mut events_sent,
    )
    .await;
    log_close(CloseRecord {
        connection_id,
        reason,
        lived: opened_at.elapsed(),
        events_sent,
    });
}

/// Runs one socket until it closes and returns why. `events_sent` follows
/// every event frame the socket delivers.
async fn serve_socket(
    mut socket: WebSocket,
    state: &ServerState,
    auth: SocketAuth,
    codec: &CursorCodec,
    connection_id: Uuid,
    events_sent: &mut u64,
) -> CloseReason {
    let SocketAuth {
        ticket,
        mut guard,
        mut signals,
    } = auth;
    let connect_stream_seq = match receive_connect(&mut socket, &ticket, codec).await {
        Ok(sequence) => sequence,
        Err(reason) => {
            reject_connect(&mut socket).await;
            return reason;
        }
    };
    let pool = state.db_pool();
    let account_id = ticket.account_id.as_str();
    let (mut sender, mut receiver): (SplitSink<_, _>, SplitStream<_>) = socket.split();
    let mut event_wake = state.chat_sync_wakes().subscribe(account_id);
    let mut listener = state.chat_sync_wakes().listener_status();
    let mut status = *listener.borrow_and_update();
    let mut delivery = Delivery::new(Instant::now(), connect_stream_seq, status.connected);
    let hello = HelloFrame {
        frame_type: "hello",
        connection_id,
        protocol_version: PROTOCOL_VERSION,
        heartbeat_interval_ms: HEARTBEAT_INTERVAL.as_millis() as u64,
        max_frame_bytes: MAX_SERVER_FRAME_BYTES,
    };
    if let Err(error) = send_json(&mut sender, &hello).await {
        return error.reason();
    }
    let end = delivery
        .deliver(pool, account_id, codec, &mut sender, status.connected)
        .await;
    *events_sent = delivery.events_sent();
    if let DeliveryEnd::Resync(reason) = end {
        return resync_and_close(&mut sender, reason).await;
    }

    let mut heartbeat_check = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_liveness = Instant::now();

    loop {
        let deliver = tokio::select! {
            incoming = receiver.next() => match incoming {
                Some(Ok(Message::Text(body))) => {
                    let Ok(ClientFrame::Heartbeat { last_applied_seq }) =
                        serde_json::from_str::<ClientFrame>(&body)
                    else {
                        return resync_and_close(&mut sender, CloseReason::InvalidFrame).await;
                    };
                    let Some(advanced) = delivery.acknowledge(last_applied_seq) else {
                        return resync_and_close(&mut sender, CloseReason::InvalidSequence).await;
                    };
                    last_liveness = Instant::now();
                    let applied = delivery.last_applied_seq;
                    match persist_device_ack(pool, account_id, &ticket.device_id, applied).await {
                        Ok(true) => {}
                        Ok(false) => {
                            send_close(&mut sender).await;
                            return CloseReason::SessionEnded;
                        }
                        // The ack is monotonic, so the next heartbeat stores it.
                        Err(error) => eprintln!("[chat-realtime] persist device ack: {error}"),
                    }
                    if let Err(error) = send_json(&mut sender, &HeartbeatAckFrame {
                        frame_type: "heartbeat_ack",
                        server_time: Utc::now(),
                    }).await {
                        return error.reason();
                    }
                    advanced && delivery.paused()
                }
                Some(Ok(Message::Ping(payload))) => {
                    last_liveness = Instant::now();
                    if let Err(error) = send_message(&mut sender, Message::Pong(payload)).await {
                        return error.reason();
                    }
                    false
                }
                Some(Ok(Message::Pong(_))) => {
                    last_liveness = Instant::now();
                    false
                }
                Some(Ok(Message::Close(_))) => return CloseReason::ClientClosed,
                None | Some(Err(_)) => return CloseReason::ClientGone,
                Some(Ok(_)) => {
                    return resync_and_close(&mut sender, CloseReason::InvalidFrame).await;
                }
            },
            _ = event_wake.recv() => true,
            _ = tokio::time::sleep_until(delivery.repair_deadline()) => true,
            _ = heartbeat_check.tick() => {
                if last_liveness.elapsed() > HEARTBEAT_TIMEOUT {
                    send_close(&mut sender).await;
                    return CloseReason::HeartbeatTimeout;
                }
                if let Err(error) = send_message(&mut sender, Message::Ping(Vec::new())).await {
                    return error.reason();
                }
                false
            }
            verdict = signals.recv() => match verdict {
                SignalVerdict::Close => {
                    send_close(&mut sender).await;
                    return CloseReason::SessionEnded;
                }
                SignalVerdict::Recheck => {
                    guard.recheck_within(Instant::now(), Duration::ZERO);
                    false
                }
            },
            _ = tokio::time::sleep_until(guard.deadline()) => {
                let now = Instant::now();
                let step = if guard.must_close(now) {
                    GuardStep::Close(CloseReason::LegacyTicketLifetime)
                } else {
                    let check = check_connection(pool, &ticket, state.admission()).await;
                    guard.record(Instant::now(), check)
                };
                if let GuardStep::Close(reason) = step {
                    send_close(&mut sender).await;
                    return reason;
                }
                false
            }
            changed = listener_changed(&mut listener) => {
                let reconnected = changed.connected && changed.epoch != status.epoch;
                status = changed;
                if !changed.connected {
                    delivery.repair_within(Instant::now(), REPAIR_WITHOUT_LISTENER);
                } else if reconnected {
                    // Signals and wakes sent while it was down may be lost.
                    let now = Instant::now();
                    guard.recheck_within(now, CATCH_UP_SPREAD);
                    delivery.repair_within(now, CATCH_UP_SPREAD);
                }
                false
            }
        };
        if deliver {
            let end = delivery
                .deliver(pool, account_id, codec, &mut sender, status.connected)
                .await;
            *events_sent = delivery.events_sent();
            if let DeliveryEnd::Resync(reason) = end {
                return resync_and_close(&mut sender, reason).await;
            }
        }
    }
}
