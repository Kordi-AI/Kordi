//! Close reasons, the clamped heartbeat acknowledgement, and the spread of
//! database-outage resyncs.

use std::collections::HashSet;
use std::time::Duration;

use tokio::time::Instant;
use uuid::Uuid;

use super::close::{CloseReason, CloseRecord};
use super::delivery::{Delivery, DeliveryEnd};
use super::frames::SendError;
use super::retry::{FAILURE_GRACE, FAILURE_GRACE_SPREAD};
use super::session::{GuardStep, SessionCheck, SessionGuard};

const ALL_REASONS: [CloseReason; 14] = [
    CloseReason::ClientClosed,
    CloseReason::ClientGone,
    CloseReason::HeartbeatTimeout,
    CloseReason::InvalidConnect,
    CloseReason::InvalidFrame,
    CloseReason::InvalidSequence,
    CloseReason::SendTimeout,
    CloseReason::FrameTooLarge,
    CloseReason::CursorExpired,
    CloseReason::StreamGap,
    CloseReason::DatabaseUnavailable,
    CloseReason::ServerError,
    CloseReason::SessionEnded,
    CloseReason::LegacyTicketLifetime,
];

#[test]
fn every_reason_logs_a_distinct_stable_name() {
    let names = ALL_REASONS
        .iter()
        .map(|reason| reason.as_str())
        .collect::<HashSet<_>>();
    assert_eq!(names.len(), ALL_REASONS.len());
    assert!(names
        .iter()
        .all(|name| name.chars().all(|c| c.is_ascii_lowercase() || c == '_')));
}

#[test]
fn the_close_line_names_reason_lifetime_and_events_only() {
    let connection_id = Uuid::now_v7();
    let line = CloseRecord {
        connection_id,
        reason: CloseReason::HeartbeatTimeout,
        lived: Duration::from_millis(65_432),
        events_sent: 7,
    }
    .log_line();
    assert_eq!(
        line,
        format!(
            "[chat-realtime] socket closed reason=heartbeat_timeout lived_ms=65432 \
             events_sent=7 connection={connection_id}"
        )
    );
}

#[test]
fn resync_frames_keep_the_reasons_released_apps_already_receive() {
    for (reason, wire) in [
        (CloseReason::InvalidFrame, "INVALID_CLIENT_FRAME"),
        (CloseReason::InvalidSequence, "INVALID_CLIENT_SEQUENCE"),
        (CloseReason::CursorExpired, "SYNC_CURSOR_EXPIRED"),
        (CloseReason::StreamGap, "STREAM_SEQUENCE_GAP"),
        (CloseReason::SendTimeout, "CLIENT_TOO_SLOW"),
        (CloseReason::FrameTooLarge, "CLIENT_TOO_SLOW"),
        (CloseReason::ClientGone, "CLIENT_TOO_SLOW"),
        (CloseReason::DatabaseUnavailable, "SERVER_ERROR"),
        (CloseReason::ServerError, "SERVER_ERROR"),
    ] {
        assert_eq!(reason.resync_reason(), wire, "{reason:?}");
    }
}

#[test]
fn failed_sends_tell_slow_oversized_and_gone_clients_apart() {
    assert_eq!(SendError::Timeout.reason(), CloseReason::SendTimeout);
    assert_eq!(SendError::TooLarge.reason(), CloseReason::FrameTooLarge);
    assert_eq!(SendError::Closed.reason(), CloseReason::ClientGone);
    assert_eq!(SendError::Encode.reason(), CloseReason::ServerError);
}

#[test]
fn session_guard_closes_name_their_cause() {
    let now = Instant::now();
    let mut signed_out = SessionGuard::new(now, None, None);
    assert_eq!(
        signed_out.record(now, SessionCheck::Inactive),
        GuardStep::Close(CloseReason::SessionEnded)
    );
    let expiry = chrono::Utc::now() + chrono::Duration::seconds(1);
    let mut expired = SessionGuard::new(now, Some(expiry), None);
    assert_eq!(
        expired.record(now + Duration::from_secs(2), SessionCheck::Unavailable),
        GuardStep::Close(CloseReason::SessionEnded)
    );
    let mut outage = SessionGuard::new(now, None, None);
    assert_eq!(
        outage.record(now, SessionCheck::Unavailable),
        GuardStep::Continue
    );
    assert_eq!(
        outage.record(
            now + FAILURE_GRACE + FAILURE_GRACE_SPREAD,
            SessionCheck::Unavailable
        ),
        GuardStep::Close(CloseReason::DatabaseUnavailable)
    );
}

#[test]
fn a_heartbeat_ahead_of_the_socket_is_clamped_to_what_it_sent() {
    let mut delivery = Delivery::new(Instant::now(), 10, true);
    assert_eq!(
        delivery.acknowledge(25),
        Some(false),
        "ahead of the socket: kept open, nothing new acknowledged"
    );
    assert_eq!(delivery.last_applied_seq, 10);
    delivery.sent_for_test(20);
    assert_eq!(delivery.acknowledge(15), Some(true));
    assert_eq!(delivery.last_applied_seq, 15);
    assert_eq!(delivery.acknowledge(1_000_000), Some(true));
    assert_eq!(
        delivery.last_applied_seq, 20,
        "never acknowledges past what this socket sent"
    );
    assert_eq!(
        delivery.acknowledge(19),
        None,
        "going backwards still closes"
    );
    assert_eq!(delivery.acknowledge(-1), None, "negative still closes");
}

#[test]
fn sockets_failing_together_do_not_resync_together() {
    let started = Instant::now();
    let mut sockets = (0..200)
        .map(|_| Delivery::new(started, 0, true))
        .collect::<Vec<_>>();
    for socket in &mut sockets {
        assert_eq!(socket.fail_for_test(started), DeliveryEnd::Continue);
    }
    // A wake reaches every socket just after the shared grace.
    let wake = started + FAILURE_GRACE + Duration::from_secs(1);
    let resynced = sockets
        .iter_mut()
        .map(|socket| socket.fail_for_test(wake))
        .filter(|end| *end != DeliveryEnd::Continue)
        .count();
    assert!(
        resynced < 50,
        "{resynced} of 200 sockets resynced on one wake"
    );

    // Each socket's own deadline ends it within the spread window.
    let mut ends = Vec::new();
    for socket in &mut sockets {
        let mut now = wake;
        loop {
            match socket.fail_for_test(now) {
                DeliveryEnd::Continue => {
                    assert!(
                        socket.repair_deadline() > now,
                        "a failed read retries later, not at once"
                    );
                    now = socket.repair_deadline();
                }
                DeliveryEnd::Resync(reason) => {
                    assert_eq!(reason, CloseReason::DatabaseUnavailable);
                    break;
                }
            }
        }
        ends.push(now.duration_since(started));
    }
    let first = *ends.iter().min().unwrap();
    let last = *ends.iter().max().unwrap();
    assert!(first >= FAILURE_GRACE, "{first:?}");
    assert!(last <= FAILURE_GRACE + FAILURE_GRACE_SPREAD, "{last:?}");
    assert!(
        last - first >= Duration::from_secs(20),
        "resyncs spread over the window: {first:?} to {last:?}"
    );
}
