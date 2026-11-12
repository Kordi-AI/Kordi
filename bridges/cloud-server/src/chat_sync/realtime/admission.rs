//! A process-wide limit on how fast realtime tickets are issued.
//!
//! When many sockets drop at once, every client asks for a ticket again, and
//! clients cannot coordinate among themselves. A token bucket in each server
//! process therefore admits reconnects at a bounded rate: by default 50 per
//! second with a burst of 100. A request over the limit is refused at once,
//! never queued, with a `Retry-After` drawn at random from 1 to 10 seconds so
//! refused clients do not come back in step. Apps keep working through their
//! HTTP sync while they wait. The gate applies only to ticket issuing and
//! sits after authentication, so requests without a session cannot use up
//! the shared budget.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::response::Response;
use rand::Rng;

/// Overrides the tickets each process issues per second.
pub const REALTIME_TICKETS_PER_SECOND_ENV: &str = "KORDI_CHAT_REALTIME_TICKETS_PER_SECOND";
/// Overrides how many tickets a process may issue at once after a quiet spell.
pub const REALTIME_TICKET_BURST_ENV: &str = "KORDI_CHAT_REALTIME_TICKET_BURST";
const DEFAULT_TICKETS_PER_SECOND: u32 = 50;
const DEFAULT_TICKET_BURST: u32 = 100;
/// The largest override accepted for either value.
const MAX_TICKET_SETTING: u32 = 100_000;
/// Refused clients are told to wait a random whole number of seconds in
/// this range.
const RETRY_AFTER_SECONDS: std::ops::RangeInclusive<u64> = 1..=10;

type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

/// The token bucket that admits realtime ticket requests.
pub struct TicketAdmission {
    per_second: f64,
    burst: f64,
    clock: Clock,
    bucket: Mutex<Bucket>,
}

struct Bucket {
    tokens: f64,
    refilled_at: Instant,
}

impl TicketAdmission {
    /// A bucket that starts full and refills at `per_second`.
    pub fn new(per_second: u32, burst: u32) -> Self {
        Self::with_clock(per_second, burst, Arc::new(Instant::now))
    }

    /// Sized from [`REALTIME_TICKETS_PER_SECOND_ENV`] and
    /// [`REALTIME_TICKET_BURST_ENV`]; invalid values use the defaults.
    pub fn from_env() -> Self {
        let read = |name: &str| std::env::var(name).ok();
        Self::new(
            setting_from(
                read(REALTIME_TICKETS_PER_SECOND_ENV).as_deref(),
                DEFAULT_TICKETS_PER_SECOND,
            ),
            setting_from(
                read(REALTIME_TICKET_BURST_ENV).as_deref(),
                DEFAULT_TICKET_BURST,
            ),
        )
    }

    fn with_clock(per_second: u32, burst: u32, clock: Clock) -> Self {
        let burst = f64::from(burst.max(1));
        let now = clock();
        Self {
            per_second: f64::from(per_second.max(1)),
            burst,
            clock,
            bucket: Mutex::new(Bucket {
                tokens: burst,
                refilled_at: now,
            }),
        }
    }

    /// Takes one token if one is available.
    pub fn try_admit(&self) -> bool {
        let now = (self.clock)();
        let mut bucket = self
            .bucket
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let elapsed = now.saturating_duration_since(bucket.refilled_at);
        bucket.tokens = (bucket.tokens + elapsed.as_secs_f64() * self.per_second).min(self.burst);
        bucket.refilled_at = now;
        if bucket.tokens < 1.0 {
            return false;
        }
        bucket.tokens -= 1.0;
        true
    }
}

/// The answer to a request over the limit: the usual rate-limit shape with
/// a random wait, so refused clients spread their next attempt.
pub(crate) fn ticket_refusal() -> Response {
    let seconds = rand::thread_rng().gen_range(RETRY_AFTER_SECONDS);
    crate::auth::rate_limit::rate_limited_response_with(
        Duration::from_secs(seconds),
        "Too many connections are opening right now.",
    )
}

fn setting_from(value: Option<&str>, default: u32) -> u32 {
    value
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| (1..=MAX_TICKET_SETTING).contains(value))
        .unwrap_or(default)
}

#[cfg(test)]
pub(super) mod tests {
    use std::collections::HashSet;

    use axum::http::{header, StatusCode};

    use super::*;

    /// A clock the test moves by hand.
    #[derive(Clone)]
    pub(in crate::chat_sync::realtime) struct ManualClock(Arc<Mutex<Instant>>);

    impl ManualClock {
        pub(in crate::chat_sync::realtime) fn new() -> Self {
            Self(Arc::new(Mutex::new(Instant::now())))
        }

        pub(in crate::chat_sync::realtime) fn advance(&self, by: Duration) {
            *self.0.lock().unwrap() += by;
        }

        pub(in crate::chat_sync::realtime) fn admission(
            &self,
            per_second: u32,
            burst: u32,
        ) -> TicketAdmission {
            let clock = self.0.clone();
            TicketAdmission::with_clock(per_second, burst, Arc::new(move || *clock.lock().unwrap()))
        }
    }

    fn admitted(admission: &TicketAdmission, attempts: usize) -> usize {
        (0..attempts).filter(|_| admission.try_admit()).count()
    }

    #[test]
    fn a_burst_gets_exactly_the_bucket_and_the_rest_are_refused() {
        let clock = ManualClock::new();
        let admission = clock.admission(DEFAULT_TICKETS_PER_SECOND, DEFAULT_TICKET_BURST);
        assert_eq!(admitted(&admission, 1_000), 100);
        assert!(!admission.try_admit());
    }

    #[test]
    fn tokens_refill_at_the_configured_rate_up_to_the_burst() {
        let clock = ManualClock::new();
        let admission = clock.admission(50, 100);
        assert_eq!(admitted(&admission, 100), 100);
        clock.advance(Duration::from_secs(1));
        assert_eq!(admitted(&admission, 1_000), 50, "one second refills 50");
        clock.advance(Duration::from_millis(500));
        assert_eq!(admitted(&admission, 1_000), 25, "half a second refills 25");
        clock.advance(Duration::from_millis(10));
        assert_eq!(
            admitted(&admission, 1_000),
            0,
            "a fraction of a token is not enough"
        );
        clock.advance(Duration::from_secs(3_600));
        assert_eq!(
            admitted(&admission, 1_000),
            100,
            "an idle hour refills only to the burst"
        );
    }

    #[test]
    fn a_steady_rate_over_ten_seconds_admits_the_rate_plus_the_burst() {
        let clock = ManualClock::new();
        let admission = clock.admission(50, 100);
        let mut total = 0;
        for _ in 0..100 {
            total += admitted(&admission, 1_000);
            clock.advance(Duration::from_millis(100));
        }
        // 100 at once, then 50 per second for the 9.9 s that followed.
        assert_eq!(total, 100 + 495);
    }

    #[tokio::test]
    async fn refusals_ask_for_a_random_wait_of_one_to_ten_seconds() {
        let mut waits = HashSet::new();
        for _ in 0..200 {
            let response = ticket_refusal();
            assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
            let header = response.headers()[header::RETRY_AFTER]
                .to_str()
                .unwrap()
                .parse::<u64>()
                .unwrap();
            assert!((1..=10).contains(&header), "{header}");
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["errorCode"], "rate_limited");
            assert_eq!(body["retryAfterSeconds"], header);
            waits.insert(header);
        }
        assert!(waits.len() >= 5, "refused clients spread out: {waits:?}");
    }

    #[test]
    fn settings_default_to_fifty_per_second_and_a_burst_of_one_hundred() {
        assert_eq!(setting_from(None, DEFAULT_TICKETS_PER_SECOND), 50);
        assert_eq!(setting_from(None, DEFAULT_TICKET_BURST), 100);
        assert_eq!(setting_from(Some(" 20 "), DEFAULT_TICKETS_PER_SECOND), 20);
        for invalid in ["0", "-5", "fast", "", "100001"] {
            assert_eq!(setting_from(Some(invalid), 50), 50, "{invalid:?}");
        }
    }
}
