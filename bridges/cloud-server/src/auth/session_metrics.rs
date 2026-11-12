//! Aggregate session diagnostics. No account, token, device, or route IDs.
//!
//! Reporting is opt-in; operators retain the output in restricted storage.
//! Set `KORDI_SESSION_METRICS_INTERVAL_SECONDS` before server startup to an
//! integer from 10 through 86400 to emit cumulative JSON to stderr. Missing
//! or invalid settings disable reporting. Counters still accumulate locally.
//! Compare deltas within one process lifetime; restarts reset all counters.
//! Eviction counters count invalidation events, not removed entry counts.
//! Request timing covers the authenticated middleware and response creation,
//! not response-body streaming or WebSocket lifetime. Pool wait and database
//! timing cover bearer-session lookups only. Buckets have inclusive upper
//! bounds and are disjoint; concurrent snapshots are approximate.
//! `chat_send` adds fixed-label stage timings for completed HTTP sends and
//! returned errors, with abandoned futures counted separately. Handler timing
//! begins after request extraction/authentication; store and handler totals
//! overlap their sub-stages. Other background store callers are not included.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::session_signals::SessionSignalHub;

pub(crate) mod send;

const BOUNDS_US: [u64; 10] = [
    100,
    500,
    1_000,
    5_000,
    10_000,
    50_000,
    100_000,
    500_000,
    1_000_000,
    u64::MAX,
];

#[derive(Clone, Copy)]
pub(crate) enum Counter {
    Hit,
    Miss,
    Bypass,
    LookupError,
    SignalEviction,
    MutationEviction,
    ListenerClear,
    GapClear,
}
const COUNTER_NAMES: [&str; 8] = [
    "cache_hit",
    "cache_miss",
    "cache_bypass",
    "lookup_error",
    "signal_eviction",
    "mutation_eviction",
    "listener_clear",
    "gap_clear",
];

#[derive(Clone, Copy)]
pub(crate) enum RequestKind {
    Message,
    Receipt,
    Sync,
    Bootstrap,
    Realtime,
    Other,
}
impl RequestKind {
    pub(crate) fn from_path(path: &str) -> Self {
        match path {
            "/v2/chat/sync" => Self::Sync,
            "/v2/chat/sync/bootstrap" => Self::Bootstrap,
            "/v2/chat/realtime/ticket" => Self::Realtime,
            p if p.starts_with("/v2/chat/conversations/") && p.ends_with("/messages") => {
                Self::Message
            }
            p if p.starts_with("/v2/chat/conversations/")
                && (p.ends_with("/read") || p.ends_with("/delivered")) =>
            {
                Self::Receipt
            }
            _ => Self::Other,
        }
    }
}
const REQUEST_NAMES: [&str; 6] = [
    "message",
    "receipt",
    "sync",
    "bootstrap",
    "realtime",
    "other",
];

#[derive(Default)]
struct Histogram {
    count: AtomicU64,
    sum_us: AtomicU64,
    buckets: [AtomicU64; 10],
}
impl Histogram {
    fn observe(&self, elapsed: Duration) {
        let micros = elapsed.as_micros().min(u64::MAX as u128) as u64;
        self.count.fetch_add(1, Ordering::Relaxed);
        self.sum_us.fetch_add(micros, Ordering::Relaxed);
        let bucket = BOUNDS_US.iter().position(|bound| micros <= *bound).unwrap();
        self.buckets[bucket].fetch_add(1, Ordering::Relaxed);
    }
    fn snapshot(&self) -> Value {
        json!({"count": self.count.load(Ordering::Relaxed), "sum_us": self.sum_us.load(Ordering::Relaxed),
            "buckets": self.buckets.iter().map(|bucket| bucket.load(Ordering::Relaxed)).collect::<Vec<_>>()})
    }
}

#[derive(Default)]
pub(crate) struct SessionMetrics {
    pub(crate) send: send::SendTimings,
    counters: [AtomicU64; 8],
    pool_wait: Histogram,
    lookup: Histogram,
    requests: [Histogram; 6],
}
impl SessionMetrics {
    pub(crate) fn increment(&self, counter: Counter) {
        self.counters[counter as usize].fetch_add(1, Ordering::Relaxed);
    }
    pub(crate) fn pool_wait(&self, elapsed: Duration) {
        self.pool_wait.observe(elapsed);
    }
    pub(crate) fn lookup(&self, elapsed: Duration) {
        self.lookup.observe(elapsed);
    }
    pub(crate) fn request(&self, kind: RequestKind, elapsed: Duration) {
        self.requests[kind as usize].observe(elapsed);
    }
    /// Cumulative, approximate snapshots: concurrent updates need not be atomic
    /// across fields. Bucket counts are disjoint, with inclusive upper bounds.
    pub(crate) fn snapshot(&self) -> Value {
        let counters: serde_json::Map<String, Value> = COUNTER_NAMES
            .iter()
            .zip(&self.counters)
            .map(|(name, count)| ((*name).to_string(), json!(count.load(Ordering::Relaxed))))
            .collect();
        let requests: serde_json::Map<String, Value> = REQUEST_NAMES
            .iter()
            .zip(&self.requests)
            .map(|(name, histogram)| ((*name).to_string(), histogram.snapshot()))
            .collect();
        json!({"schema": 1, "counters": counters, "bucket_upper_us": BOUNDS_US,
            "pool_wait": self.pool_wait.snapshot(), "database_lookup": self.lookup.snapshot(), "requests": requests, "chat_send": self.send.snapshot()})
    }
}

pub(crate) fn spawn_reporter(hub: Arc<SessionSignalHub>) {
    let Some(seconds) = std::env::var("KORDI_SESSION_METRICS_INTERVAL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|seconds| (10..=86_400).contains(seconds))
    else {
        return;
    };
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(seconds));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await;
        loop {
            interval.tick().await;
            eprintln!(
                "[session-metrics] {}",
                hub.lookup_cache().metrics().snapshot()
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshots_use_only_fixed_labels_and_preserve_counts() {
        let metrics = SessionMetrics::default();
        metrics.increment(Counter::Hit);
        metrics.pool_wait(Duration::from_micros(101));
        metrics.request(
            RequestKind::from_path("/v2/chat/conversations/private-id/messages"),
            Duration::from_micros(500),
        );
        let snapshot = metrics.snapshot();
        assert_eq!(snapshot["counters"]["cache_hit"], 1);
        assert_eq!(snapshot["pool_wait"]["buckets"][1], 1);
        assert_eq!(snapshot["requests"]["message"]["count"], 1);
        assert!(!snapshot.to_string().contains("private-id"));
        assert_eq!(
            snapshot["counters"].as_object().unwrap().len(),
            COUNTER_NAMES.len()
        );
    }
}
