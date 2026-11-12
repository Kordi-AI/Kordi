//! Wire frames of the realtime protocol and the helpers that send them.

use axum::extract::ws::{Message, WebSocket};
use chrono::{DateTime, Utc};
use futures_util::stream::SplitSink;
use futures_util::SinkExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::close::CloseReason;
use super::ticket::ConsumedRealtimeTicket;
use super::{CONNECT_TIMEOUT, MAX_SERVER_FRAME_BYTES, SEND_TIMEOUT};
use crate::chat_sync::cursor::CursorCodec;
use crate::chat_sync::models::SyncEventSnapshot;
use crate::chat_sync::PROTOCOL_VERSION;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum ClientFrame {
    Connect {
        protocol_version: i32,
        device_id: String,
        cursor: String,
    },
    Heartbeat {
        last_applied_seq: i64,
    },
}

#[derive(Serialize)]
pub(super) struct HelloFrame {
    #[serde(rename = "type")]
    pub(super) frame_type: &'static str,
    pub(super) connection_id: Uuid,
    pub(super) protocol_version: i32,
    pub(super) heartbeat_interval_ms: u64,
    pub(super) max_frame_bytes: usize,
}

#[derive(Serialize)]
pub(super) struct EventFrame<'a> {
    #[serde(rename = "type")]
    pub(super) frame_type: &'static str,
    pub(super) stream_seq: i64,
    pub(super) cursor: String,
    pub(super) event: &'a SyncEventSnapshot,
}

#[derive(Serialize)]
pub(super) struct HeartbeatAckFrame {
    #[serde(rename = "type")]
    pub(super) frame_type: &'static str,
    pub(super) server_time: DateTime<Utc>,
}

#[derive(Serialize)]
struct ResyncRequiredFrame<'a> {
    #[serde(rename = "type")]
    frame_type: &'static str,
    reason: &'a str,
}

#[derive(Serialize)]
struct ErrorFrame<'a> {
    #[serde(rename = "type")]
    frame_type: &'static str,
    code: &'a str,
}

/// Why a frame could not be sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SendError {
    /// The frame is larger than [`MAX_SERVER_FRAME_BYTES`].
    TooLarge,
    /// The client did not take the frame within [`SEND_TIMEOUT`].
    Timeout,
    /// The connection is already gone.
    Closed,
    /// The frame could not be serialized.
    Encode,
}

impl SendError {
    pub(super) fn reason(self) -> CloseReason {
        match self {
            Self::TooLarge => CloseReason::FrameTooLarge,
            Self::Timeout => CloseReason::SendTimeout,
            Self::Closed => CloseReason::ClientGone,
            Self::Encode => CloseReason::ServerError,
        }
    }
}

fn encode<T: Serialize>(value: &T) -> Result<String, SendError> {
    let body = serde_json::to_string(value).map_err(|_| SendError::Encode)?;
    if body.len() > MAX_SERVER_FRAME_BYTES {
        return Err(SendError::TooLarge);
    }
    Ok(body)
}

/// Sends one message, giving up after [`SEND_TIMEOUT`].
pub(super) async fn send_message(
    sender: &mut SplitSink<WebSocket, Message>,
    message: Message,
) -> Result<(), SendError> {
    tokio::time::timeout(SEND_TIMEOUT, sender.send(message))
        .await
        .map_err(|_| SendError::Timeout)?
        .map_err(|_| SendError::Closed)
}

pub(super) async fn send_json<T: Serialize>(
    sender: &mut SplitSink<WebSocket, Message>,
    value: &T,
) -> Result<(), SendError> {
    send_message(sender, Message::Text(encode(value)?)).await
}

/// Sends a close frame, giving up after [`SEND_TIMEOUT`] so a client that
/// stopped reading cannot hold the socket open.
pub(super) async fn send_close(sender: &mut SplitSink<WebSocket, Message>) {
    let _ = send_message(sender, Message::Close(None)).await;
}

/// Refuses a socket whose connect frame was not accepted.
pub(super) async fn reject_connect(socket: &mut WebSocket) {
    let frame = ErrorFrame {
        frame_type: "error",
        code: "INVALID_CONNECT_FRAME",
    };
    if let Ok(body) = encode(&frame) {
        let _ = tokio::time::timeout(SEND_TIMEOUT, socket.send(Message::Text(body))).await;
    }
    let _ = tokio::time::timeout(SEND_TIMEOUT, socket.send(Message::Close(None))).await;
}

/// Waits for the connect frame and returns the stream position it resumes
/// from, or why the socket must close.
pub(super) async fn receive_connect(
    socket: &mut WebSocket,
    ticket: &ConsumedRealtimeTicket,
    codec: &CursorCodec,
) -> Result<i64, CloseReason> {
    let incoming = tokio::time::timeout(CONNECT_TIMEOUT, socket.recv())
        .await
        .map_err(|_| CloseReason::InvalidConnect)?;
    let body = match incoming {
        Some(Ok(Message::Text(body))) => body,
        Some(Ok(Message::Close(_))) => return Err(CloseReason::ClientClosed),
        None | Some(Err(_)) => return Err(CloseReason::ClientGone),
        Some(Ok(_)) => return Err(CloseReason::InvalidConnect),
    };
    let Ok(ClientFrame::Connect {
        protocol_version,
        device_id,
        cursor,
    }) = serde_json::from_str::<ClientFrame>(&body)
    else {
        return Err(CloseReason::InvalidConnect);
    };
    if protocol_version != PROTOCOL_VERSION || device_id != ticket.device_id {
        return Err(CloseReason::InvalidConnect);
    }
    codec
        .decode(&cursor, &ticket.account_id)
        .map_err(|_| CloseReason::InvalidConnect)
}

/// Asks the client to resync, closes, and returns `reason` for the log.
pub(super) async fn resync_and_close(
    sender: &mut SplitSink<WebSocket, Message>,
    reason: CloseReason,
) -> CloseReason {
    let _ = send_json(
        sender,
        &ResyncRequiredFrame {
            frame_type: "resync_required",
            reason: reason.resync_reason(),
        },
    )
    .await;
    send_close(sender).await;
    reason
}
