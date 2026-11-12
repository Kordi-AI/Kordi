//! Run payload retention against a disposable Postgres. Fixture rows are
//! dated in 2000 (2010 for the batching test) and sweeps use a cutoff a
//! year later, so a sweep never touches rows another suite writes into the
//! same database, and the other tests here cannot empty the batching test's
//! candidates before it counts them.

use super::*;
use chrono::TimeZone;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use uuid::Uuid;

async fn pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .ok()
        .filter(|url| !url.trim().is_empty())
        .expect("run payload retention tests need DATABASE_URL for a disposable database");
    crate::pg::init_pool(&url).await.expect("init test pool")
}

fn cutoff() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2001, 1, 1, 0, 0, 0).unwrap()
}

fn old() -> String {
    Utc.with_ymd_and_hms(2000, 1, 1, 0, 0, 0)
        .unwrap()
        .to_rfc3339()
}

fn batch_cutoff() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2011, 1, 1, 0, 0, 0).unwrap()
}

fn batch_old() -> String {
    Utc.with_ymd_and_hms(2010, 1, 1, 0, 0, 0)
        .unwrap()
        .to_rfc3339()
}

async fn account(pool: &PgPool) -> String {
    let account_id = format!("acct_run_retention_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, avatar_source, \
          avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, 'Retention', $2, $3, $3, 'generated', 'lorelei', $1, 'fixture', 1, $3)",
    )
    .bind(&account_id)
    .bind(format!("{account_id}@example.test"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    account_id
}

async fn cleanup(pool: &PgPool, account_id: &str) {
    for sql in [
        "DELETE FROM cloud_agent_fallback_runs WHERE owner_account_id = $1",
        "DELETE FROM cloud_accounts WHERE account_id = $1",
    ] {
        query(sql).bind(account_id).execute(pool).await.unwrap();
    }
}

/// Inserts a run with every cleared column filled and returns its id.
async fn run(
    pool: &PgPool,
    owner: &str,
    status: &str,
    updated_at: &str,
    completed_at: Option<&str>,
) -> String {
    let run_id = format!("run_retention_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_agent_fallback_runs \
         (run_id, idempotency_key, request_message_id, session_id, owner_account_id, \
          requester_account_id, status, prompt, system_prompt, runtime_route_json, \
          response_message_id, created_at, updated_at, completed_at, omp_input_json, \
          turn_identity, run_trigger, connector_audience, connector_tools_json) \
         VALUES ($1, $1, $1, 'retention-session', $2, $2, $3, 'frozen prompt', 'system prompt', \
                 '{\"defaultModel\":\"test/model\"}'::jsonb, 'msg_reply', $4, $4, $5, \
                 '{\"prompt\":\"frozen\",\"history\":[]}'::jsonb, \
                 '{\"conversationMembersDigest\":\"digest\"}'::jsonb, 'person_started', \
                 'shared', '[{\"name\":\"tool\"}]'::jsonb)",
    )
    .bind(&run_id)
    .bind(owner)
    .bind(status)
    .bind(updated_at)
    .bind(completed_at)
    .execute(pool)
    .await
    .unwrap();
    run_id
}

type Payload = (String, Option<Value>, Option<Value>, Value);

async fn payload(pool: &PgPool, run_id: &str) -> Payload {
    query_as(
        "SELECT prompt, omp_input_json, turn_identity, connector_tools_json \
         FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

fn cleared() -> Payload {
    (String::new(), None, None, json!([]))
}

fn intact() -> Payload {
    (
        "frozen prompt".into(),
        Some(json!({"prompt":"frozen","history":[]})),
        Some(json!({"conversationMembersDigest":"digest"})),
        json!([{"name":"tool"}]),
    )
}

#[tokio::test]
#[ignore = "needs DATABASE_URL for a disposable database"]
async fn old_finished_runs_lose_their_frozen_input() {
    let pool = pool().await;
    let owner = account(&pool).await;
    let old = old();
    let completed = run(&pool, &owner, "completed", &old, Some(&old)).await;
    let failed = run(&pool, &owner, "failed", &old, Some(&old)).await;
    // A cancelled run may have no completion time; its last update counts.
    let cancelled = run(&pool, &owner, "cancelled", &old, None).await;
    // Postgres-style text written by `now()::text` compares the same way.
    let pg_text = run(
        &pool,
        &owner,
        "completed",
        "2000-01-01 00:00:00.123456+00",
        Some("2000-01-01 00:00:00.123456+00"),
    )
    .await;

    sweep_expired_run_payloads(&pool, cutoff(), RUN_PAYLOAD_SWEEP_BATCH, Duration::ZERO)
        .await
        .unwrap();

    for run_id in [&completed, &failed, &cancelled, &pg_text] {
        assert_eq!(payload(&pool, run_id).await, cleared(), "{run_id}");
    }
    cleanup(&pool, &owner).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL for a disposable database"]
async fn recent_and_unfinished_runs_keep_their_frozen_input() {
    let pool = pool().await;
    let owner = account(&pool).await;
    let old = old();
    let now = Utc::now().to_rfc3339();
    let recent = run(&pool, &owner, "completed", &now, Some(&now)).await;
    // Finished long ago but updated since: the latest time counts.
    let touched = run(&pool, &owner, "completed", &now, Some(&old)).await;
    let mut unfinished = Vec::new();
    for status in ["queued", "leased", "running"] {
        unfinished.push(run(&pool, &owner, status, &old, None).await);
    }

    sweep_expired_run_payloads(&pool, cutoff(), RUN_PAYLOAD_SWEEP_BATCH, Duration::ZERO)
        .await
        .unwrap();

    assert_eq!(payload(&pool, &recent).await, intact());
    assert_eq!(payload(&pool, &touched).await, intact());
    for run_id in &unfinished {
        assert_eq!(payload(&pool, run_id).await, intact(), "{run_id}");
    }
    cleanup(&pool, &owner).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL for a disposable database"]
async fn clearing_keeps_the_row_its_history_and_its_dependents() {
    let pool = pool().await;
    let owner = account(&pool).await;
    let old = old();
    let run_id = run(&pool, &owner, "completed", &old, Some(&old)).await;
    query(
        "INSERT INTO cloud_agent_omp_state \
         (run_id, owner_account_id, session_id, execution_agent_id, route_json, auth_snapshot_id, \
          provider, model, response_message_id, state_json) \
         VALUES ($1, $2, 'retention-session', $3, '{}'::jsonb, 'snap_test', 'openai', 'gpt-test', \
                 'msg_reply', '{\"schemaVersion\":1,\"messages\":[]}'::jsonb)",
    )
    .bind(&run_id)
    .bind(&owner)
    .bind(format!("cloud-agent:{owner}"))
    .execute(&pool)
    .await
    .unwrap();

    sweep_expired_run_payloads(&pool, cutoff(), RUN_PAYLOAD_SWEEP_BATCH, Duration::ZERO)
        .await
        .unwrap();

    assert_eq!(payload(&pool, &run_id).await, cleared());
    // The fields later turns and readers still use stay as they were.
    let kept: (
        String,
        String,
        String,
        String,
        Value,
        String,
        String,
        Option<String>,
    ) = query_as(
        "SELECT status, idempotency_key, request_message_id, system_prompt, runtime_route_json, \
                response_message_id, updated_at, completed_at \
         FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        kept,
        (
            "completed".to_string(),
            run_id.clone(),
            run_id.clone(),
            "system prompt".to_string(),
            json!({"defaultModel":"test/model"}),
            "msg_reply".to_string(),
            old.clone(),
            Some(old.clone()),
        )
    );
    let (states,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_agent_omp_state WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(states, 1, "replay state referencing the run survives");
    cleanup(&pool, &owner).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL for a disposable database"]
async fn sweep_clears_in_bounded_batches_and_is_idempotent() {
    let pool = pool().await;
    let owner = account(&pool).await;
    let old = batch_old();
    let mut runs = Vec::new();
    for _ in 0..5 {
        runs.push(run(&pool, &owner, "completed", &old, Some(&old)).await);
    }

    let first = clear_expired_run_payloads_batch(&pool, batch_cutoff(), 2)
        .await
        .unwrap();
    assert_eq!(first, 2, "one statement clears at most its batch");
    let rest = sweep_expired_run_payloads(&pool, batch_cutoff(), 2, Duration::ZERO)
        .await
        .unwrap();
    assert!(rest >= 3, "the sweep keeps going until a short batch");
    for run_id in &runs {
        assert_eq!(payload(&pool, run_id).await, cleared(), "{run_id}");
    }
    // Cleared rows are not rewritten by a later sweep.
    let versions = row_versions(&pool, &owner).await;
    sweep_expired_run_payloads(&pool, batch_cutoff(), 2, Duration::ZERO)
        .await
        .unwrap();
    assert_eq!(row_versions(&pool, &owner).await, versions);
    cleanup(&pool, &owner).await;
}

async fn row_versions(pool: &PgPool, owner: &str) -> Vec<(String, String)> {
    query_as(
        "SELECT run_id, xmin::text FROM cloud_agent_fallback_runs \
         WHERE owner_account_id = $1 ORDER BY run_id",
    )
    .bind(owner)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[test]
fn retention_window_is_thirty_days_with_bounded_batches() {
    assert_eq!(RUN_PAYLOAD_RETENTION_DAYS, 30);
    assert!((1..=1000).contains(&RUN_PAYLOAD_SWEEP_BATCH));
}
