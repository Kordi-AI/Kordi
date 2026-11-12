//! Retention for the frozen inputs of finished agent runs.
//!
//! A run keeps its row for good: artifacts, shared documents, agent
//! exchanges, replay state and subsession messages reference it, its
//! request and idempotency keys stop a request from running twice, and
//! subsession follow-ups and exchange resumes inherit its system prompt and
//! route. What only matters while a run executes is its frozen input: the
//! assembled prompt, the runtime input with chat history, the turn identity
//! with its conversation note, and the connector tool list delivered at
//! lease time. Thirty days after a run finished, those columns are cleared
//! in place.
//!
//! The cleared values are the ones older rows already have, and every
//! reader handles them: the runtime input is read only while a run is
//! leased or running, the prompt and connector tools at most a day after it
//! finished (a proactive offer expires after 24 hours, an agent exchange
//! after its deadline), a subsession transcript replays a turn without a
//! frozen identity from its chat text, and the conversation note repeats
//! the member list when no earlier digest remains.

use std::time::Duration;

use chrono::{DateTime, Utc};
use sqlx_core::query::query;
use sqlx_postgres::PgPool;

/// Days after a run finished before its frozen input is cleared.
pub const RUN_PAYLOAD_RETENTION_DAYS: i64 = 30;
/// Rows cleared per statement, so a large first sweep never holds long
/// locks or writes one huge transaction.
pub const RUN_PAYLOAD_SWEEP_BATCH: i64 = 500;
const RUN_PAYLOAD_SWEEP_PAUSE: Duration = Duration::from_millis(200);

/// Clears the frozen input of at most `limit` finished runs whose completion
/// and last update are both before `cutoff`. Rows another transaction holds
/// are skipped until a later sweep. Returns the rows cleared.
pub async fn clear_expired_run_payloads_batch(
    pool: &PgPool,
    cutoff: DateTime<Utc>,
    limit: i64,
) -> Result<u64, sqlx_core::Error> {
    // `completed_at` and `updated_at` are RFC 3339 text; GREATEST skips a
    // missing completion time.
    let cleared = query(
        "UPDATE cloud_agent_fallback_runs run \
         SET prompt = '', omp_input_json = NULL, turn_identity = NULL, \
             connector_tools_json = '[]'::jsonb \
         FROM ( \
             SELECT run_id FROM cloud_agent_fallback_runs \
             WHERE status IN ('completed', 'failed', 'cancelled') \
               AND GREATEST(completed_at::timestamptz, updated_at::timestamptz) < $1 \
               AND (prompt <> '' OR omp_input_json IS NOT NULL OR turn_identity IS NOT NULL \
                    OR connector_tools_json <> '[]'::jsonb) \
             LIMIT $2 \
             FOR UPDATE SKIP LOCKED \
         ) expired \
         WHERE run.run_id = expired.run_id",
    )
    .bind(cutoff)
    .bind(limit)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(cleared)
}

/// Clears every expired run payload in batches of `batch`, pausing for
/// `pause` between batches. Returns the rows cleared.
pub async fn sweep_expired_run_payloads(
    pool: &PgPool,
    cutoff: DateTime<Utc>,
    batch: i64,
    pause: Duration,
) -> Result<u64, sqlx_core::Error> {
    let mut total = 0;
    loop {
        let cleared = clear_expired_run_payloads_batch(pool, cutoff, batch).await?;
        total += cleared;
        if cleared < batch as u64 {
            return Ok(total);
        }
        tokio::time::sleep(pause).await;
    }
}

/// One retention pass as of now, for the periodic retention worker.
pub async fn run_payload_retention_sweep(pool: &PgPool) {
    let cutoff = Utc::now() - chrono::Duration::days(RUN_PAYLOAD_RETENTION_DAYS);
    match sweep_expired_run_payloads(
        pool,
        cutoff,
        RUN_PAYLOAD_SWEEP_BATCH,
        RUN_PAYLOAD_SWEEP_PAUSE,
    )
    .await
    {
        Ok(0) => {}
        Ok(cleared) => eprintln!("[agent-runs] retention cleared the inputs of {cleared} runs"),
        Err(error) => eprintln!("[agent-runs] retention sweep: {error}"),
    }
}

#[cfg(test)]
#[path = "retention_tests.rs"]
mod tests;
