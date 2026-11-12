//! The background workers the server starts once its state exists.

use std::sync::Arc;
use std::time::Duration;

use super::ServerState;

impl ServerState {
    /// Starts this replica's notification listener (chat wakes, session
    /// signals, and collaboration rooms) and waits up to `within` for it to
    /// listen; returns whether it is listening. [`super::run`] starts it with
    /// the other workers. Tests that serve a router with open sockets start
    /// it themselves, since sign-out reaches those sockets through it.
    pub async fn start_notification_listener(&self, database_url: &str, within: Duration) -> bool {
        crate::chat_sync::realtime::spawn_wake_listener(
            database_url.to_string(),
            self.chat_sync_wakes().clone(),
            self.session_signals().clone(),
            self.document_rooms().clone(),
        );
        let mut status = self.chat_sync_wakes().listener_status();
        tokio::time::timeout(within, status.wait_for(|status| status.connected))
            .await
            .is_ok_and(|listening| listening.is_ok())
    }
}

/// Starts every periodic worker: realtime wakes, support tickets, abuse
/// report notices and retention, scheduled
/// tasks, digests, the System agent, proactive and personal agents,
/// Grounding nearby alerts and automatic card updates, plan-card
/// projection, retention, terminal backfill, deleted-object cleanup, and
/// the notification workers when notifications are configured.
pub(super) fn spawn_background_workers(
    state: &Arc<ServerState>,
    database_url: &str,
    rate_limiter: &Arc<crate::auth::rate_limit::CloudRateLimiter>,
) {
    crate::chat_sync::realtime::spawn_wake_listener(
        database_url.to_string(),
        state.chat_sync_wakes().clone(),
        state.session_signals().clone(),
        state.document_rooms().clone(),
    );
    crate::support::spawn_ticket_worker(state.clone());
    crate::safety::spawn_report_notice_worker(state.clone());
    crate::safety::spawn_report_retention_worker(state.db_pool().clone());
    crate::scheduled_tasks::worker::spawn_scheduled_task_worker(state.clone());
    crate::digest::spawn(state.clone());
    crate::system_agent::spawn(state.clone());
    crate::pool_workers::spawn_maintenance(state.clone());
    crate::proactive::spawn(state.clone());
    crate::personal_agent::spawn(state.clone());
    crate::common_ground::spawn_nearby(state.clone(), rate_limiter.clone());
    crate::common_ground::spawn_auto_rebuild(state.clone());
    crate::plan_cards::projection::spawn(state.db_pool().clone());
    crate::chat_sync::retention::spawn_retention_worker(state.db_pool().clone());
    crate::cloud_agent_runtime::runs::terminal_backfill::spawn(state.db_pool().clone());
    crate::organizations::admission::spawn(state.clone());
    crate::account_deletion::objects::spawn(state.clone());
    crate::auth::oauth::apple::spawn_revocation_worker(state.clone());
    if let Some(notifications) = state.notifications() {
        notifications.spawn_message_notification_worker(state.db_pool().clone());
        notifications.spawn_calendar_worker(state.db_pool().clone());
    }
}
