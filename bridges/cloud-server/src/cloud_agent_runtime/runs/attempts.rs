//! Bounded Cloud runner retries.
//!
//! Every Cloud lease of a run adds one to `cloud_lease_attempts`. A lease
//! lapses when its runner stops renewing it without finishing the run: the
//! runner crashed, was redeployed, or failed the step before it could report
//! anything (for example a lease it could not read). Such a run is leased
//! again, but only [`MAX_CLOUD_LEASE_ATTEMPTS`] times in all. After that the
//! sweep fails it through the same path a runner-reported failure takes, so
//! its feature (a chat reply, a Grounding card, a digest) ends failed instead
//! of staying in progress forever.

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::RunResult;

/// How many Cloud leases a run gets before the sweep fails it.
/// [`attempts_limit!`] is the same number for SQL text.
pub const MAX_CLOUD_LEASE_ATTEMPTS: i32 = 3;

/// [`MAX_CLOUD_LEASE_ATTEMPTS`] as a literal for `concat!` SQL.
macro_rules! attempts_limit {
    () => {
        "3"
    };
}
pub(super) use attempts_limit;

/// The error code of a run failed after its last lease lapsed.
pub const EXHAUSTED_ERROR_CODE: &str = "run_attempts_exhausted";
const EXHAUSTED_MESSAGE: &str = "The Cloud runner did not finish this run after several attempts.";
/// The runner id the sweep holds a run under while it fails it.
const SWEEP_RUNNER_ID: &str = "kordi-server:attempts-sweep";
const SWEEP_LIMIT: i64 = 50;

/// Fails every Cloud run whose last allowed lease lapsed, and returns how
/// many it failed. Each run is first taken over under the sweep's own runner
/// id with a short live lease, so the runner failure path, which accepts only
/// the current holder of a live lease, ends it exactly as a runner would.
/// Stop-requested runs are left to the stopped-run sweep, desktop runs to the
/// lost-desktop sweep, and pool worker runs to their pool's own lease cap.
pub async fn fail_exhausted_runs(pool: &PgPool) -> RunResult<usize> {
    let runs: Vec<(String, i32)> = query_as(
        "UPDATE cloud_agent_fallback_runs SET claimed_by = $1, \
           lease_expires_at = (now() + interval '60 seconds')::text, updated_at = now()::text \
         WHERE run_id IN ( \
           SELECT run.run_id FROM cloud_agent_fallback_runs run \
           WHERE run.execution_backend = 'cloud' AND run.status IN ('leased', 'running') \
             AND run.cloud_lease_attempts >= $2 \
             AND run.lease_expires_at IS NOT NULL AND run.lease_expires_at::timestamptz <= now() \
             AND run.cancel_requested_at IS NULL \
             AND NOT EXISTS(SELECT 1 FROM cloud_pool_worker_runs w WHERE w.run_id = run.run_id) \
           ORDER BY run.lease_expires_at LIMIT $3 FOR UPDATE SKIP LOCKED) \
         RETURNING run_id, cloud_lease_attempts",
    )
    .bind(SWEEP_RUNNER_ID)
    .bind(MAX_CLOUD_LEASE_ATTEMPTS)
    .bind(SWEEP_LIMIT)
    .fetch_all(pool)
    .await?;
    let mut failed = 0;
    for (run_id, attempts) in runs {
        let result = super::completion::fail_run(
            pool,
            &run_id,
            SWEEP_RUNNER_ID,
            EXHAUSTED_ERROR_CODE,
            EXHAUSTED_MESSAGE,
            None,
        )
        .await;
        match result {
            Ok(_) => {
                failed += 1;
                eprintln!(
                    "[cloud_agent_runtime] failed run {run_id} after {attempts} lapsed Cloud leases"
                );
            }
            Err(error) => {
                eprintln!("[cloud_agent_runtime] failing exhausted run {run_id}: {error}");
            }
        }
    }
    Ok(failed)
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_sql_limit_matches_the_constant() {
        assert_eq!(
            attempts_limit!().parse::<i32>().unwrap(),
            super::MAX_CLOUD_LEASE_ATTEMPTS
        );
    }
}
