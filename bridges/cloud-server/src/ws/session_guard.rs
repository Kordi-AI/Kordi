//! When an open gateway socket rechecks its session, and whether a result
//! closes it.
//!
//! Sign-out, device revocation, and account deletion reach the socket at once
//! as a session signal, the same one chat realtime sockets use. The socket
//! also rechecks PostgreSQL every ~30 s, jittered per socket, as a backstop.
//! A database error retries with backoff instead of closing: the socket closes
//! only after its checks have failed for a full minute in a row, and a
//! session that is really gone closes at the next check that succeeds.

use std::time::Duration;

use tokio::time::Instant;

use super::WsConnection;
use crate::auth::admission::AdmissionError;
use crate::auth::session::session_is_active;
use crate::chat_sync::realtime::retry::{jittered, Backoff};
use crate::server::ServerState;

/// The backstop recheck interval; each socket jitters it by ±20 %.
pub(super) const GATEWAY_RECHECK_INTERVAL: Duration = Duration::from_secs(30);
/// How long checks may keep failing before the socket closes.
pub(super) const GATEWAY_FAILURE_GRACE: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum GatewayCheck {
    /// The session is live and the account is admitted.
    Active,
    /// Signed out, expired, revoked, deleted, or no longer admitted.
    Inactive,
    /// The database could not answer; the verdict is unknown.
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum GatewayStep {
    Continue,
    Close,
}

/// The recheck schedule of one gateway socket.
#[derive(Debug)]
pub(super) struct GatewayGuard {
    next_check: Instant,
    failing_since: Option<Instant>,
    backoff: Backoff,
}

impl GatewayGuard {
    /// A guard for a socket whose session was just found active.
    pub(super) fn new(now: Instant) -> Self {
        Self {
            next_check: now + jittered(GATEWAY_RECHECK_INTERVAL),
            failing_since: None,
            backoff: Backoff::default(),
        }
    }

    /// When the next check is due.
    pub(super) fn deadline(&self) -> Instant {
        self.next_check
    }

    /// Check at `now`, for a signal that asks for a recheck.
    pub(super) fn recheck_now(&mut self, now: Instant) {
        self.next_check = self.next_check.min(now);
    }

    /// Applies a check made at `now`.
    pub(super) fn record(&mut self, now: Instant, check: GatewayCheck) -> GatewayStep {
        match check {
            GatewayCheck::Active => {
                self.failing_since = None;
                self.backoff = Backoff::default();
                self.next_check = now + jittered(GATEWAY_RECHECK_INTERVAL);
                GatewayStep::Continue
            }
            GatewayCheck::Inactive => GatewayStep::Close,
            GatewayCheck::Unavailable => {
                let failing_since = *self.failing_since.get_or_insert(now);
                if now.duration_since(failing_since) >= GATEWAY_FAILURE_GRACE {
                    return GatewayStep::Close;
                }
                self.next_check = now + self.backoff.next_delay();
                GatewayStep::Continue
            }
        }
    }

    /// Runs the due check against the database and applies it.
    pub(super) async fn revalidate(
        &mut self,
        state: &ServerState,
        connection: &WsConnection,
    ) -> GatewayStep {
        let check = check_connection(state, connection).await;
        let step = self.record(Instant::now(), check);
        if step == GatewayStep::Close && check == GatewayCheck::Unavailable {
            eprintln!("[ws] closing a socket: session checks failed for the failure grace");
        }
        step
    }
}

/// Checks instance admission and the session, telling a database error
/// apart from a session that is gone.
async fn check_connection(state: &ServerState, connection: &WsConnection) -> GatewayCheck {
    match state
        .admission()
        .authorize_account(state.db_pool(), &connection.account_id)
        .await
    {
        Ok(()) => {}
        Err(AdmissionError::Unavailable) => return GatewayCheck::Unavailable,
        Err(_) => return GatewayCheck::Inactive,
    }
    match session_is_active(
        state.db_pool(),
        &connection.account_id,
        &connection.device_id,
        &connection.token_id,
    )
    .await
    {
        Ok(true) => GatewayCheck::Active,
        Ok(false) => GatewayCheck::Inactive,
        Err(error) => {
            eprintln!("[ws] revalidate session: {error}");
            GatewayCheck::Unavailable
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn within_jitter(delay: Duration) -> bool {
        delay >= GATEWAY_RECHECK_INTERVAL.mul_f64(0.8)
            && delay <= GATEWAY_RECHECK_INTERVAL.mul_f64(1.2)
    }

    #[test]
    fn rechecks_every_thirty_seconds_with_per_socket_jitter() {
        let mut delays = Vec::new();
        for _ in 0..200 {
            let now = Instant::now();
            let mut guard = GatewayGuard::new(now);
            delays.push(guard.deadline() - now);
            assert_eq!(
                guard.record(now, GatewayCheck::Active),
                GatewayStep::Continue
            );
            delays.push(guard.deadline() - now);
        }
        assert!(
            delays.iter().all(|delay| within_jitter(*delay)),
            "every recheck waits 24 to 36 s, not 2 s"
        );
        assert!(
            delays.iter().min() != delays.iter().max(),
            "sockets opened together spread their checks"
        );
    }

    #[test]
    fn database_errors_close_only_after_a_minute_of_failures() {
        let opened = Instant::now();
        let mut guard = GatewayGuard::new(opened);
        let mut now = opened;
        let mut checks = 0;
        while now.duration_since(opened) < GATEWAY_FAILURE_GRACE {
            assert_eq!(
                guard.record(now, GatewayCheck::Unavailable),
                GatewayStep::Continue,
                "failing for {:?} keeps the socket open",
                now.duration_since(opened)
            );
            checks += 1;
            assert!(guard.deadline() - now <= Duration::from_secs(36));
            now = guard.deadline();
        }
        assert!(checks > 1, "failed checks retry before the grace ends");
        assert_eq!(
            guard.record(now, GatewayCheck::Unavailable),
            GatewayStep::Close
        );
    }

    #[test]
    fn a_success_restarts_the_grace_and_a_gone_session_closes_at_once() {
        let opened = Instant::now();
        let mut guard = GatewayGuard::new(opened);
        assert_eq!(
            guard.record(opened, GatewayCheck::Unavailable),
            GatewayStep::Continue
        );
        let later = opened + Duration::from_secs(50);
        assert_eq!(
            guard.record(later, GatewayCheck::Active),
            GatewayStep::Continue
        );
        assert_eq!(
            guard.record(later + Duration::from_secs(30), GatewayCheck::Unavailable),
            GatewayStep::Continue,
            "the failure grace counts consecutive failures only"
        );
        assert_eq!(
            guard.record(later + Duration::from_secs(31), GatewayCheck::Inactive),
            GatewayStep::Close,
            "a session found gone closes at the next successful check"
        );
    }

    #[test]
    fn a_recheck_signal_pulls_the_check_forward() {
        let now = Instant::now();
        let mut guard = GatewayGuard::new(now);
        guard.recheck_now(now);
        assert_eq!(guard.deadline(), now);
    }
}
