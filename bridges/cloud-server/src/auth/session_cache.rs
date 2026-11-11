//! A short-lived, per-replica cache of successful session lookups.
//!
//! Every authenticated request resolves its bearer token. Recipient devices
//! of a busy group make several requests per message, so the same few
//! sessions are looked up over and over. This cache keeps a successful
//! lookup for a few seconds, keyed by the token's SHA-256 hash (never the
//! token itself), and is bounded in size.
//!
//! Revocation still takes effect at once on every replica. Database
//! triggers (migrations 0175 and 0197) publish a `cloud_session_signals`
//! notification whenever a session, device, account, organization claim,
//! personal organization, or organization membership changes, and each
//! replica's notification listener evicts every cached lookup of the
//! affected account. The cache only serves entries while that listener is
//! demonstrably live: it must be connected and must have received a
//! notification (at least the replica's own heartbeat) within the liveness
//! window. Otherwise lookups bypass the cache, and the cache is emptied
//! before it is used again, because signals may have been missed.
//!
//! A cached entry is never served past the session's expiry, nor past the
//! expiry of the organization membership its claim depends on.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use sqlx_postgres::PgPool;

use super::session::{
    hash_session_token, lookup_session_by_hash, SessionError, SessionLookup, SESSION_TOKEN_PREFIX,
};

/// How long a successful lookup is served from the cache.
pub(crate) const CACHE_TTL: Duration = Duration::from_secs(30);
/// At most this many sessions are cached per replica.
pub(crate) const CACHE_CAPACITY: usize = 50_000;
/// The listener counts as live only if it received a notification this
/// recently. Each replica sends itself a heartbeat well within it.
pub(crate) const LIVENESS_WINDOW: Duration = Duration::from_secs(15);
/// How often each replica sends its heartbeat notification.
pub(crate) const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
/// The heartbeat payload on `cloud_session_signals`. It names no account,
/// so signal parsing (on this and older replicas) ignores it.
pub(crate) const HEARTBEAT_PAYLOAD: &str = r#"{"k":"ping"}"#;
/// A full cache drops expired entries at most this often, and eviction
/// records are pruned at most this often.
const PURGE_INTERVAL: Duration = Duration::from_secs(1);
/// A database answer that took longer than this is not cached. Eviction
/// records older than this are pruned, which this deadline makes safe.
const FILL_DEADLINE: Duration = Duration::from_secs(60);

/// Where a lookup's answer came from. Database lookups refresh the
/// session's sliding expiry and the device's activity; cached ones do not
/// need to, because the cache is refilled from the database within
/// [`CACHE_TTL`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LookupSource {
    Cache,
    Database,
}

struct Entry {
    lookup: SessionLookup,
    fresh_until: Instant,
}

impl Entry {
    fn servable(&self, now: Instant, wall: DateTime<Utc>) -> bool {
        now < self.fresh_until && self.lookup.valid_at(wall)
    }
}

#[derive(Default)]
struct CacheState {
    entries: HashMap<String, Entry>,
    /// Token hashes cached for each account, so signals evict by account.
    by_account: HashMap<String, Vec<String>>,
    /// Grows on every eviction or clear. A database lookup that started
    /// before an eviction of its account (or a clear) may have read the
    /// evicted state, so its answer is not cached.
    sequence: u64,
    cleared_at: u64,
    /// The sequence number and time of each account's latest eviction,
    /// kept for [`FILL_DEADLINE`].
    evicted: HashMap<String, (u64, Instant)>,
    connected: bool,
    last_notification: Option<Instant>,
    last_purge: Option<Instant>,
    last_eviction_prune: Option<Instant>,
}

impl CacheState {
    fn clear(&mut self) {
        self.entries.clear();
        self.by_account.clear();
        self.evicted.clear();
        self.sequence += 1;
        self.cleared_at = self.sequence;
    }

    fn evict_account(&mut self, account_id: &str, now: Instant) {
        self.sequence += 1;
        let sequence = self.sequence;
        self.evicted.insert(account_id.to_string(), (sequence, now));
        if let Some(hashes) = self.by_account.remove(account_id) {
            for hash in hashes {
                self.entries.remove(&hash);
            }
        }
        let may_prune = self
            .last_eviction_prune
            .is_none_or(|at| now.saturating_duration_since(at) >= PURGE_INTERVAL);
        if may_prune {
            self.evicted
                .retain(|_, (_, at)| now.saturating_duration_since(*at) <= FILL_DEADLINE);
            self.last_eviction_prune = Some(now);
        }
    }

    /// Whether an answer for `account_id` read under `ticket` may be cached.
    fn ticket(&self, now: Instant) -> Ticket {
        Ticket {
            sequence: self.sequence,
            issued: now,
        }
    }

    fn may_fill(&self, account_id: &str, ticket: Ticket, now: Instant) -> bool {
        now.saturating_duration_since(ticket.issued) <= FILL_DEADLINE
            && self.cleared_at <= ticket.sequence
            && self
                .evicted
                .get(account_id)
                .is_none_or(|(sequence, _)| *sequence <= ticket.sequence)
    }

    fn live(&self, now: Instant, window: Duration) -> bool {
        self.connected
            && self
                .last_notification
                .is_some_and(|at| now.saturating_duration_since(at) <= window)
    }

    fn remove(&mut self, token_hash: &str) {
        let Some(entry) = self.entries.remove(token_hash) else {
            return;
        };
        let account_id = &entry.lookup.row.account_id;
        if let Some(hashes) = self.by_account.get_mut(account_id) {
            hashes.retain(|hash| hash != token_hash);
            if hashes.is_empty() {
                self.by_account.remove(account_id);
            }
        }
    }

    fn purge_expired(&mut self, now: Instant, wall: DateTime<Utc>) {
        let expired: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, entry)| !entry.servable(now, wall))
            .map(|(hash, _)| hash.clone())
            .collect();
        for hash in expired {
            self.remove(&hash);
        }
        self.last_purge = Some(now);
    }
}

/// Permission to cache the answer of a database lookup that starts now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Ticket {
    sequence: u64,
    issued: Instant,
}

/// What a cache probe found: a servable entry, or permission to fill the
/// cache with a database answer (`None` when the cache must be bypassed).
enum Probe {
    Hit(SessionLookup),
    Miss(Option<Ticket>),
}

pub(crate) struct SessionLookupCache {
    ttl: Duration,
    capacity: usize,
    liveness_window: Duration,
    state: Mutex<CacheState>,
}

impl Default for SessionLookupCache {
    fn default() -> Self {
        Self::with_limits(CACHE_TTL, CACHE_CAPACITY, LIVENESS_WINDOW)
    }
}

impl SessionLookupCache {
    pub(crate) fn with_limits(ttl: Duration, capacity: usize, liveness_window: Duration) -> Self {
        Self {
            ttl,
            capacity,
            liveness_window,
            state: Mutex::new(CacheState::default()),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, CacheState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Resolves a plaintext session token like
    /// [`super::session::lookup_session`], serving a recent successful
    /// answer from the cache when the listener is live.
    pub(crate) async fn lookup(
        &self,
        pool: &PgPool,
        plaintext_token: &str,
    ) -> Result<Option<(SessionLookup, LookupSource)>, SessionError> {
        if !plaintext_token.starts_with(SESSION_TOKEN_PREFIX) {
            return Ok(None);
        }
        let token_hash = hash_session_token(plaintext_token);
        let ticket = match self.probe(&token_hash, Instant::now(), Utc::now()) {
            Probe::Hit(lookup) => return Ok(Some((lookup, LookupSource::Cache))),
            Probe::Miss(ticket) => ticket,
        };
        let found = lookup_session_by_hash(pool, &token_hash, Utc::now()).await?;
        if let (Some(found), Some(ticket)) = (&found, ticket) {
            self.fill(token_hash, found, ticket, Instant::now(), Utc::now());
        }
        Ok(found.map(|found| (found, LookupSource::Database)))
    }

    fn probe(&self, token_hash: &str, now: Instant, wall: DateTime<Utc>) -> Probe {
        let mut state = self.state();
        if !state.live(now, self.liveness_window) {
            if !state.entries.is_empty() {
                state.clear();
            }
            return Probe::Miss(None);
        }
        match state.entries.get(token_hash) {
            Some(entry) if entry.servable(now, wall) => Probe::Hit(entry.lookup.clone()),
            Some(_) => {
                state.remove(token_hash);
                Probe::Miss(Some(state.ticket(now)))
            }
            None => Probe::Miss(Some(state.ticket(now))),
        }
    }

    fn fill(
        &self,
        token_hash: String,
        lookup: &SessionLookup,
        ticket: Ticket,
        now: Instant,
        wall: DateTime<Utc>,
    ) {
        let mut state = self.state();
        if !state.live(now, self.liveness_window)
            || !state.may_fill(&lookup.row.account_id, ticket, now)
        {
            return;
        }
        let entry = Entry {
            lookup: lookup.clone(),
            fresh_until: now + self.ttl,
        };
        if !entry.servable(now, wall) {
            return;
        }
        if !state.entries.contains_key(&token_hash) && state.entries.len() >= self.capacity {
            let may_purge = state
                .last_purge
                .is_none_or(|at| now.saturating_duration_since(at) >= PURGE_INTERVAL);
            if may_purge {
                state.purge_expired(now, wall);
            }
            if state.entries.len() >= self.capacity {
                return;
            }
        }
        state.remove(&token_hash);
        state
            .by_account
            .entry(entry.lookup.row.account_id.clone())
            .or_default()
            .push(token_hash.clone());
        state.entries.insert(token_hash, entry);
    }

    /// Drops every cached lookup of `account_id`, and keeps lookups that
    /// are already in flight from being cached.
    pub(crate) fn evict_account(&self, account_id: &str) {
        self.state().evict_account(account_id, Instant::now());
    }

    /// The notification listener connected or disconnected. Either way the
    /// cache starts empty: a disconnected listener may have missed signals.
    pub(crate) fn set_listener_connected(&self, connected: bool) {
        let mut state = self.state();
        if state.connected != connected {
            state.clear();
        }
        state.connected = connected;
        state.last_notification = None;
    }

    /// The listener received a notification on any channel. A gap longer
    /// than the liveness window since the previous one means signals may
    /// have been lost, so the cache is emptied first.
    pub(crate) fn notification_received(&self) {
        self.notification_received_at(Instant::now());
    }

    fn notification_received_at(&self, now: Instant) {
        let mut state = self.state();
        let gap = state
            .last_notification
            .is_none_or(|at| now.saturating_duration_since(at) > self.liveness_window);
        if gap {
            state.clear();
        }
        state.last_notification = Some(now);
    }

    #[cfg(test)]
    pub(crate) fn is_live(&self) -> bool {
        self.state().live(Instant::now(), self.liveness_window)
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.state().entries.len()
    }
}

#[cfg(test)]
mod tests;
