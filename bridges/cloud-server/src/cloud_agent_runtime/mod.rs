pub mod artifacts;
mod claim_route;
mod desktop;
mod desktop_tasks;
pub(crate) mod factory_runs;
pub(crate) mod import_runs;
pub mod policy;
pub mod provider_auth;
mod provider_auth_intent;
mod provider_login;
pub mod routes;
pub mod run_locks;
pub mod runs;
pub mod sandboxes;
mod shared_threads;
pub(crate) mod subsession_execution;
mod sync_events;

pub(crate) use desktop::agent_desktop_ready;

/// Seconds a desktop claim or renewal holds a run before the Mac must renew.
/// Long enough that a slow server (or several timed-out renewals) does not
/// stop a running Mac turn; the claim and renewal answers name it so the Mac
/// stops before the lease lapses and the run can move to another executor.
pub(crate) const DESKTOP_LEASE_SECONDS: i64 = 120;
