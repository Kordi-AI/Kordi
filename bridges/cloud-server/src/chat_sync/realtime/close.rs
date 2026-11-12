//! Why a realtime socket closed, and the one log line every closed socket
//! writes.
//!
//! Each socket ends with exactly one [`CloseReason`]. The line names it with
//! how long the socket lived and how many events it sent, so an incident can
//! be read from the log: a proxy reset shows as `client_gone`, a client that
//! reads too slowly as `send_timeout`, a database outage as
//! `database_unavailable`. The line carries no account, device, token, or
//! message content; the connection id is the random one the hello frame gave
//! the client.

use std::time::Duration;

use uuid::Uuid;

/// The fixed set of reasons a realtime socket closes for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CloseReason {
    /// The client sent a close frame.
    ClientClosed,
    /// The connection ended without a close frame: a reset, a proxy drop,
    /// or a write to a connection that was already gone.
    ClientGone,
    /// No heartbeat, ping, or pong arrived within the heartbeat timeout.
    HeartbeatTimeout,
    /// The connect frame was late, malformed, or did not match its ticket.
    InvalidConnect,
    /// A frame after connect was malformed or not a heartbeat.
    InvalidFrame,
    /// A heartbeat reported a negative or decreasing applied sequence.
    InvalidSequence,
    /// A frame took longer than the send timeout: the client reads too
    /// slowly.
    SendTimeout,
    /// An event frame exceeded the advertised maximum frame size.
    FrameTooLarge,
    /// The connect cursor is older than retention or ahead of the stream.
    CursorExpired,
    /// The durable stream returned a sequence gap.
    StreamGap,
    /// Stream reads or session checks kept failing for the failure grace.
    DatabaseUnavailable,
    /// Reading the stream failed for another reason.
    ServerError,
    /// The session or device was signed out, revoked, expired, or deleted,
    /// or the account is no longer admitted.
    SessionEnded,
    /// A socket opened with a legacy device-only ticket reached its lifetime.
    LegacyTicketLifetime,
}

impl CloseReason {
    /// The value logged as `reason=`.
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::ClientClosed => "client_closed",
            Self::ClientGone => "client_gone",
            Self::HeartbeatTimeout => "heartbeat_timeout",
            Self::InvalidConnect => "invalid_connect",
            Self::InvalidFrame => "invalid_frame",
            Self::InvalidSequence => "invalid_sequence",
            Self::SendTimeout => "send_timeout",
            Self::FrameTooLarge => "frame_too_large",
            Self::CursorExpired => "cursor_expired",
            Self::StreamGap => "stream_gap",
            Self::DatabaseUnavailable => "database_unavailable",
            Self::ServerError => "server_error",
            Self::SessionEnded => "session_ended",
            Self::LegacyTicketLifetime => "legacy_ticket_lifetime",
        }
    }

    /// The reason a `resync_required` frame carries when this close asks the
    /// client to resync. These are the values the protocol has always sent:
    /// a slow send and an oversized frame both still read `CLIENT_TOO_SLOW`.
    pub(super) fn resync_reason(self) -> &'static str {
        match self {
            Self::InvalidFrame => "INVALID_CLIENT_FRAME",
            Self::InvalidSequence => "INVALID_CLIENT_SEQUENCE",
            Self::CursorExpired => "SYNC_CURSOR_EXPIRED",
            Self::StreamGap => "STREAM_SEQUENCE_GAP",
            Self::SendTimeout | Self::FrameTooLarge | Self::ClientGone => "CLIENT_TOO_SLOW",
            _ => "SERVER_ERROR",
        }
    }
}

/// What one closed socket reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct CloseRecord {
    pub(super) connection_id: Uuid,
    pub(super) reason: CloseReason,
    pub(super) lived: Duration,
    pub(super) events_sent: u64,
}

impl CloseRecord {
    pub(super) fn log_line(&self) -> String {
        format!(
            "[chat-realtime] socket closed reason={} lived_ms={} events_sent={} connection={}",
            self.reason.as_str(),
            self.lived.as_millis(),
            self.events_sent,
            self.connection_id,
        )
    }
}

/// Writes the close line. Called once per socket, on every path out.
pub(super) fn log_close(record: CloseRecord) {
    eprintln!("{}", record.log_line());
    #[cfg(test)]
    test_sink::push(record);
}

/// Close records kept for tests, which find their socket's record by the
/// connection id its hello frame carried.
#[cfg(test)]
pub(super) mod test_sink {
    use std::sync::Mutex;
    use std::time::Duration;

    use uuid::Uuid;

    use super::CloseRecord;

    static RECORDS: Mutex<Vec<CloseRecord>> = Mutex::new(Vec::new());

    pub(super) fn push(record: CloseRecord) {
        RECORDS
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(record);
    }

    /// Waits up to `within` for the record of `connection_id`.
    pub(in crate::chat_sync::realtime) async fn wait_for(
        connection_id: Uuid,
        within: Duration,
    ) -> Option<CloseRecord> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let found = RECORDS
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .iter()
                .find(|record| record.connection_id == connection_id)
                .cloned();
            if found.is_some() || tokio::time::Instant::now() >= deadline {
                return found;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
