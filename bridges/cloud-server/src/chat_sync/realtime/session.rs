//! Whether an open realtime socket may keep streaming, and when to ask.
//!
//! Revocation reaches a socket through the session signal hub at once. The
//! socket also rechecks PostgreSQL every ~30 s as a backstop, closes when its
//! session's known expiry passes, and keeps running through short database
//! outages instead of turning them into a reconnect storm. A long outage
//! closes sockets over a spread window rather than at one instant.

use std::time::Duration;

use chrono::{DateTime, Utc};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use tokio::time::Instant;

use super::close::CloseReason;
use super::retry::{jittered, socket_failure_grace, spread, Backoff};
use super::ticket::ConsumedRealtimeTicket;
use crate::auth::admission::AdmissionPolicy;

/// The backstop recheck interval; each socket jitters it by ±20 %.
pub(super) const SESSION_RECHECK_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SessionCheck {
    /// Signed in, admitted, and device authorized. `expires_at` is the
    /// session's expiry (`None` for a legacy device-only ticket).
    Active { expires_at: Option<DateTime<Utc>> },
    /// Signed out, expired, revoked, deleted, or no longer admitted.
    Inactive,
    /// The database could not answer; the verdict is unknown.
    Unavailable,
}

/// Checks the session (or, for a legacy ticket, the device) and instance
/// admission in one query. The session conditions match
/// [`crate::auth::session::session_is_active`].
pub(super) async fn check_connection(
    pool: &PgPool,
    ticket: &ConsumedRealtimeTicket,
    policy: &AdmissionPolicy,
) -> SessionCheck {
    type Row = (Option<String>, Option<String>, bool);
    let row: Result<Option<Row>, sqlx_core::Error> = match ticket.session_token_id.as_deref() {
        Some(token_id) => {
            query_as(
                "SELECT token.expires_at, account.primary_email, \
                        account.primary_email_verified_at IS NOT NULL \
                 FROM cloud_refresh_tokens token \
                 JOIN cloud_devices device ON device.device_id = token.device_id \
                 JOIN cloud_accounts account ON account.account_id = token.account_id \
                 WHERE token.token_id = $1 AND token.account_id = $2 AND token.device_id = $3 \
                   AND token.revoked_at IS NULL AND token.expires_at > $4 \
                   AND device.account_id = token.account_id AND device.revoked_at IS NULL",
            )
            .bind(token_id)
            .bind(&ticket.account_id)
            .bind(&ticket.device_id)
            .bind(Utc::now().to_rfc3339())
            .fetch_optional(pool)
            .await
        }
        None => {
            query_as(
                "SELECT NULL::text, account.primary_email, \
                        account.primary_email_verified_at IS NOT NULL \
                 FROM cloud_devices device \
                 JOIN cloud_accounts account ON account.account_id = device.account_id \
                 WHERE device.account_id = $1 AND device.device_id = $2 \
                   AND device.revoked_at IS NULL",
            )
            .bind(&ticket.account_id)
            .bind(&ticket.device_id)
            .fetch_optional(pool)
            .await
        }
    };
    match row {
        Ok(Some((expires_at, email, verified))) => {
            if policy.check(email.as_deref(), verified).is_err() {
                return SessionCheck::Inactive;
            }
            let expires_at = expires_at.and_then(|value| {
                DateTime::parse_from_rfc3339(&value)
                    .ok()
                    .map(|value| value.with_timezone(&Utc))
            });
            SessionCheck::Active { expires_at }
        }
        Ok(None) => SessionCheck::Inactive,
        Err(error) => {
            eprintln!("[chat-realtime] revalidate session: {error}");
            SessionCheck::Unavailable
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum GuardStep {
    Continue,
    Close(CloseReason),
}

/// When an open socket rechecks its session, and whether a result closes it.
#[derive(Debug)]
pub(super) struct SessionGuard {
    next_check: Instant,
    expires_at: Option<Instant>,
    legacy_deadline: Option<Instant>,
    failing_since: Option<Instant>,
    /// How long checks may keep failing before this socket closes.
    failure_grace: Duration,
    backoff: Backoff,
}

impl SessionGuard {
    /// A guard for a socket whose session was just found active.
    pub(super) fn new(
        now: Instant,
        expires_at: Option<DateTime<Utc>>,
        legacy_deadline: Option<Instant>,
    ) -> Self {
        Self {
            next_check: now + jittered(SESSION_RECHECK_INTERVAL),
            expires_at: expires_at.map(|expiry| instant_at(now, expiry)),
            legacy_deadline,
            failing_since: None,
            failure_grace: socket_failure_grace(),
            backoff: Backoff::default(),
        }
    }

    /// The next moment the socket must act: a recheck, the session's known
    /// expiry, or the legacy ticket deadline.
    pub(super) fn deadline(&self) -> Instant {
        [Some(self.next_check), self.expires_at, self.legacy_deadline]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(self.next_check)
    }

    /// Whether the socket must close without asking the database.
    pub(super) fn must_close(&self, now: Instant) -> bool {
        self.legacy_deadline.is_some_and(|deadline| now >= deadline)
    }

    /// Recheck no later than a random moment within `within` from `now`.
    pub(super) fn recheck_within(&mut self, now: Instant, within: Duration) {
        self.next_check = self.next_check.min(now + spread(within));
    }

    /// Applies a check made at `now`.
    pub(super) fn record(&mut self, now: Instant, check: SessionCheck) -> GuardStep {
        match check {
            SessionCheck::Active { expires_at } => {
                self.failing_since = None;
                self.backoff = Backoff::default();
                self.expires_at = expires_at.map(|expiry| instant_at(now, expiry));
                self.next_check = now + jittered(SESSION_RECHECK_INTERVAL);
                GuardStep::Continue
            }
            SessionCheck::Inactive => GuardStep::Close(CloseReason::SessionEnded),
            SessionCheck::Unavailable => {
                // Past its known expiry a session cannot be confirmed as
                // extended, so the socket fails closed.
                if self.expires_at.is_some_and(|expiry| now >= expiry) {
                    return GuardStep::Close(CloseReason::SessionEnded);
                }
                let give_up_at = *self.failing_since.get_or_insert(now) + self.failure_grace;
                if now >= give_up_at {
                    return GuardStep::Close(CloseReason::DatabaseUnavailable);
                }
                self.next_check = (now + self.backoff.next_delay()).min(give_up_at);
                GuardStep::Continue
            }
        }
    }
}

fn instant_at(now: Instant, at: DateTime<Utc>) -> Instant {
    now + (at - Utc::now()).to_std().unwrap_or_default()
}
