//! Whether a marked card is due an automatic update, without the database:
//! the sweep reads [`CardState`] and acts on the [`Decision`].

use chrono::{DateTime, Duration, Utc};

use super::config::AutoRebuildConfig;

/// What the sweep knows about one marked card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::common_ground) struct CardState {
    pub auto_rebuild: bool,
    pub built: bool,
    /// The first change no automatic update has taken yet.
    pub dirty_since: Option<DateTime<Utc>>,
    /// The latest change.
    pub last_change_at: Option<DateTime<Utc>>,
    pub manual_in_flight: bool,
    pub auto_in_flight: bool,
    /// Automatic updates queued for the card in the last hour and day.
    pub updates_last_hour: i64,
    pub updates_last_day: i64,
    /// The owner allowed AI for background work (`crate::ai_consent`).
    pub consent_allowed: bool,
}

/// Why a due card waits without being updated. It stays marked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::common_ground) enum Hold {
    /// A manual build or another automatic update is in flight.
    InFlight,
    /// The owner has not allowed AI for background work.
    NoConsent,
    /// The card's hourly or daily automatic updates are used up.
    Capped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::common_ground) enum Decision {
    /// Nothing to do: the setting is off, the card is not built, or nothing
    /// is marked. The marks are cleared.
    Clear,
    /// Changes are still coming in; look again at this time.
    Wait(DateTime<Utc>),
    Hold(Hold),
    /// Read what changed and, when something relevant did, queue an update.
    Due,
}

impl Hold {
    /// How long the card waits before the sweep looks at it again.
    pub fn retry_in(self) -> Duration {
        match self {
            Hold::InFlight => Duration::minutes(1),
            Hold::NoConsent | Hold::Capped => Duration::minutes(5),
        }
    }
}

/// The decision for one card at `now`. A card is due once its changes have
/// been quiet for the quiet window or its first change has waited the
/// maximum wait; then the in-flight, consent and cap checks apply in that
/// order. Manual builds never count against the caps.
pub(in crate::common_ground) fn decide(
    state: &CardState,
    now: DateTime<Utc>,
    config: &AutoRebuildConfig,
) -> Decision {
    let Some(dirty_since) = state.dirty_since else {
        return Decision::Clear;
    };
    if !state.auto_rebuild || !state.built {
        return Decision::Clear;
    }
    if state.manual_in_flight || state.auto_in_flight {
        return Decision::Hold(Hold::InFlight);
    }
    let last_change = state.last_change_at.unwrap_or(dirty_since).max(dirty_since);
    let quiet_at = last_change + Duration::seconds(config.quiet_seconds);
    let latest_at = dirty_since + Duration::seconds(config.max_wait_seconds);
    let due_at = quiet_at.min(latest_at);
    if now < due_at {
        return Decision::Wait(due_at);
    }
    if !state.consent_allowed {
        return Decision::Hold(Hold::NoConsent);
    }
    if state.updates_last_hour >= config.hourly_updates
        || state.updates_last_day >= config.daily_updates
    {
        return Decision::Hold(Hold::Capped);
    }
    Decision::Due
}
