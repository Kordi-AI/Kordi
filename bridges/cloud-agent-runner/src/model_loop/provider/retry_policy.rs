//! How long a provider request keeps retrying, by kind of run.

/// How long a provider request keeps retrying. `max_retries` counts every
/// attempt, as `kordi_provider::retry::with_retry` does, and a server delay
/// above `max_retry_delay_ms` fails at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderRetryPolicy {
    pub max_retries: u32,
    pub retry_base_delay_ms: u64,
    pub max_retry_delay_ms: u64,
    /// Report each rate-limited attempt to the runner's Grounding call
    /// limit (`grounding_throttle`) as it happens, not only a final failure.
    pub report_rate_limits: bool,
}

impl ProviderRetryPolicy {
    /// A person is waiting on a chat reply, so a long rate limit fails fast.
    pub const INTERACTIVE: Self = Self {
        max_retries: 2,
        retry_base_delay_ms: 250,
        max_retry_delay_ms: 2_000,
        report_rate_limits: false,
    };
    /// Background work such as Common ground runs waits out a gateway's
    /// rate limit (`Retry-After` of about 30 s under load) instead of failing.
    pub const BACKGROUND: Self = Self {
        max_retries: 4,
        retry_base_delay_ms: 2_000,
        max_retry_delay_ms: 60_000,
        report_rate_limits: true,
    };
}

impl Default for ProviderRetryPolicy {
    fn default() -> Self {
        Self::INTERACTIVE
    }
}
