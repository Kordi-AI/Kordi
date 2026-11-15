//! How many Grounding model calls this runner makes at once.
//!
//! Grounding runs (card builds, matching, room themes) all call one Kordi
//! provider key, and a large room queues far more of them than the provider
//! accepts at once. The limit starts at the runner's concurrency, halves when
//! the provider rate-limits a call (at most once per [`CUT_COOLDOWN`], so one
//! burst of 429s counts once, and never below [`MIN_LIMIT`]), and grows by one
//! after every [`GROW_AFTER`] successful calls, back up to the concurrency.
//! The limit is shared by all of the runner's workers; while it is reached,
//! the runner claims no new runs, so queued runs wait on the server instead of
//! failing here.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tokio::sync::Notify;
use tokio::time::Instant;

/// Wording providers use for a rate limit, besides status 429.
const RATE_LIMIT_WORDING: [&str; 3] = ["rate limit", "rate-limit", "too many requests"];

/// Whether a provider error's text is a rate limit.
pub(crate) fn is_rate_limit_text(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    text.contains("status 429")
        || text.contains("http 429")
        || text.contains("http_429")
        || RATE_LIMIT_WORDING
            .iter()
            .any(|wording| text.contains(wording))
}

/// A short, safe description of a failed Grounding completion for the
/// logs: the provider's HTTP status or transport failure, never its text.
pub(crate) fn failure_kind(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let status = lower
        .split("status ")
        .nth(1)
        .and_then(|rest| rest.get(..3))
        .filter(|code| code.bytes().all(|b| b.is_ascii_digit()));
    if let Some(code) = status {
        return format!("provider_http_{code}");
    }
    if let Some(code) = lower
        .split("provider_http_")
        .nth(1)
        .and_then(|rest| rest.get(..3))
        .filter(|code| code.bytes().all(|b| b.is_ascii_digit()))
    {
        return format!("provider_http_{code}");
    }
    let kinds = [
        ("rate limit", "provider_rate_limited"),
        ("too many requests", "provider_rate_limited"),
        ("timed out", "timeout"),
        ("could not connect", "provider_connect"),
        ("response stream failed", "provider_stream"),
        ("provider request failed", "provider_request"),
        ("without a reply", "empty_reply"),
        ("tool call", "tool_call"),
    ];
    kinds
        .iter()
        .find(|(wording, _)| lower.contains(wording))
        .map_or("other", |(_, kind)| kind)
        .to_string()
}

/// The limit never drops below this, so the provider is always being tried.
pub(crate) const MIN_LIMIT: usize = 2;
/// Successful calls in a row that raise the limit by one.
pub(crate) const GROW_AFTER: u32 = 3;
/// Rate limits within this long of a cut count as the same burst.
pub(crate) const CUT_COOLDOWN: Duration = Duration::from_secs(10);

#[derive(Debug)]
struct State {
    limit: usize,
    max: usize,
    in_flight: usize,
    waiting: usize,
    successes: u32,
    last_cut: Option<Instant>,
}

#[derive(Debug)]
pub struct Controller {
    state: Mutex<State>,
    freed: Notify,
}

/// One model call in flight; dropping it frees the slot.
#[derive(Debug)]
pub struct Permit<'a>(&'a Controller);

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        self.0.state().in_flight -= 1;
        self.0.freed.notify_waiters();
    }
}

impl Controller {
    pub fn new(max: usize) -> Self {
        let max = max.max(1);
        Self {
            state: Mutex::new(State {
                limit: max,
                max,
                in_flight: 0,
                waiting: 0,
                successes: 0,
                last_cut: None,
            }),
            freed: Notify::new(),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn limit(&self) -> usize {
        self.state().limit
    }

    pub fn in_flight(&self) -> usize {
        self.state().in_flight
    }

    /// Whether every slot is taken or a call is already waiting for one: the
    /// runner should not claim another run now.
    pub fn is_full(&self) -> bool {
        let state = self.state();
        state.in_flight >= state.limit || state.waiting > 0
    }

    pub fn try_acquire(&self) -> Option<Permit<'_>> {
        let mut state = self.state();
        (state.in_flight < state.limit).then(|| {
            state.in_flight += 1;
            Permit(self)
        })
    }

    /// Waits for a free slot.
    pub async fn acquire(&self) -> Permit<'_> {
        if let Some(permit) = self.try_acquire() {
            return permit;
        }
        self.state().waiting += 1;
        let permit = loop {
            let freed = self.freed.notified();
            tokio::pin!(freed);
            freed.as_mut().enable();
            if let Some(permit) = self.try_acquire() {
                break permit;
            }
            freed.await;
        };
        self.state().waiting -= 1;
        permit
    }

    /// The provider rate-limited a call.
    pub fn rate_limited(&self) {
        let now = Instant::now();
        let mut state = self.state();
        state.successes = 0;
        if state
            .last_cut
            .is_some_and(|cut| now.saturating_duration_since(cut) < CUT_COOLDOWN)
        {
            return;
        }
        let floor = MIN_LIMIT.min(state.max);
        let before = state.limit;
        state.limit = (state.limit / 2).max(floor);
        state.last_cut = Some(now);
        tracing::info!(
            before,
            limit = state.limit,
            in_flight = state.in_flight,
            "grounding calls rate-limited; limit lowered"
        );
    }

    /// A call finished without a rate limit.
    pub fn succeeded(&self) {
        let grew = {
            let mut state = self.state();
            state.successes += 1;
            let grow = state.successes >= GROW_AFTER && state.limit < state.max;
            if grow {
                state.limit += 1;
                state.successes = 0;
                tracing::info!(limit = state.limit, "grounding call limit raised");
            }
            grow
        };
        if grew {
            self.freed.notify_waiters();
        }
    }
}

/// The provider client's retry callback for Grounding calls: an attempt it
/// is about to retry for a rate limit lowers the limit at once.
pub(crate) fn report_retry(controller: &Controller, event: &kordi_provider::ProviderRetryEvent) {
    if let kordi_provider::ProviderRetryEvent::Start { error_message, .. } = event {
        if is_rate_limit_text(error_message) {
            controller.rate_limited();
        }
    }
}

/// The runner's controller, sized by `KORDI_CLOUD_RUNNER_CONCURRENCY`.
pub fn controller() -> &'static Controller {
    static CONTROLLER: OnceLock<Controller> = OnceLock::new();
    CONTROLLER.get_or_init(|| {
        let concurrency = std::env::var("KORDI_CLOUD_RUNNER_CONCURRENCY")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(4);
        Controller::new(concurrency)
    })
}

#[cfg(test)]
#[path = "grounding_throttle_tests.rs"]
mod tests;
