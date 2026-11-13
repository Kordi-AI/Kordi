//! "Rebuild automatically" (#2433): a per-card setting, off by default, that
//! keeps a built card up to date with memory and connected accounts.
//!
//! Memory writes and new connector events mark the owner's cards that have
//! it on ([`mark`]). A sweep worker ([`sweep`]) waits until the changes go
//! quiet, or the first one has waited the maximum wait, then checks that no
//! build or update is in flight, that the owner allowed AI for background
//! work, and the per-card caps ([`decide`]). It reads only what changed
//! since the card last caught up ([`delta`]) and queues one `cg_auto_` run
//! with the current card and that new evidence ([`prompt`]). The reply names
//! changes, which are merged into the stored card ([`merge`]).
//!
//! An automatic update never shows as building, never sets a build error,
//! and never uses the manual build rate limit; a manual build always wins
//! over one in flight. Each sweep also matches changed cards again
//! (`matching::rematch`). See docs/common-ground.md.

mod config;
mod decide;
mod delta;
mod finish;
mod mark;
mod merge;
mod prompt;
mod settings;
mod sweep;

use std::sync::Arc;
use std::time::Duration;

use crate::auth::rate_limit::CloudRateLimiter;
use crate::server::ServerState;

pub(super) use finish::{complete, fail};
pub(crate) use mark::{note_connector_event, note_memory_change};
pub(super) use settings::{apply as apply_settings, SettingsRequest};

#[cfg(test)]
pub(super) use config::AutoRebuildConfig;
#[cfg(test)]
pub(super) use decide::{decide, CardState, Decision, Hold};
#[cfg(test)]
pub(super) use delta::{removed, same_reference, NewItem};
#[cfg(test)]
pub(super) use merge::{merge, parse_update, StoredCard};
#[cfg(test)]
pub(super) use prompt::user_prompt;
#[cfg(test)]
pub(super) use sweep::{sweep, Outcome};

/// Automatic update runs.
pub(super) const AUTO_PREFIX: &str = "cg_auto_";

/// Starts the sweep; it skips ticks while Grounding is unavailable. Match
/// runs it queues are charged to `rate_limiter`, the limiter the routes share.
pub(super) fn spawn(state: Arc<ServerState>, rate_limiter: Arc<CloudRateLimiter>) {
    tokio::spawn(async move {
        let config = config::config();
        let mut timer = tokio::time::interval(Duration::from_secs(config.sweep_seconds));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            let Some(service) = state.system_agent() else {
                continue;
            };
            let swept = sweep::sweep(state.db_pool(), service.config(), &rate_limiter, &config);
            if let Err(error) = swept.await {
                eprintln!(
                    "[common-ground] Automatic update sweep failed; retrying on the next tick: {error}"
                );
            }
        }
    });
}
