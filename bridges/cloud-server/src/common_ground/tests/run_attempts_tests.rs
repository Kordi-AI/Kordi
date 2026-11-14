//! A card build whose runner keeps losing the lease ends failed after a
//! bounded number of Cloud leases instead of building forever.

use serde_json::json;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::db_fixture::{account, app, pool, send, signed_in};
use crate::cloud_agent_runtime::runs::attempts::{
    fail_exhausted_runs, EXHAUSTED_ERROR_CODE, MAX_CLOUD_LEASE_ATTEMPTS,
};
use crate::cloud_agent_runtime::runs::lease_canary_run;

const RUNNER: &str = "cg-attempts-runner";

/// Lets the run's lease lapse as a runner that failed the step would.
async fn lapse(pool: &PgPool, run_id: &str) {
    query("UPDATE cloud_agent_fallback_runs SET lease_expires_at = $2 WHERE run_id = $1")
        .bind(run_id)
        .bind((chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339())
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_build_whose_leases_keep_lapsing_ends_failed() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    // A legacy account may have no display name, which once made every lease
    // of its runs unreadable to the runner.
    let (member, token) = signed_in(&pool, "Unnamed").await;
    query("UPDATE cloud_accounts SET display_name = NULL WHERE account_id = $1")
        .bind(&member)
        .execute(&pool)
        .await
        .unwrap();
    let card = "/v1/cloud/common-ground/card";
    let (status, body) = send(
        &app,
        "POST",
        &format!("{card}/build"),
        &token,
        Some(json!({"notes": "My work."})),
    )
    .await;
    assert_eq!(status, 202, "{body}");
    let (run_id,): (String,) =
        query_as("SELECT active_run_id FROM cloud_common_ground_cards WHERE account_id = $1")
            .bind(&member)
            .fetch_one(&pool)
            .await
            .unwrap();

    for attempt in 1..=MAX_CLOUD_LEASE_ATTEMPTS {
        let run = lease_canary_run(&pool, &format!("{RUNNER}:{attempt}"), &run_id)
            .await
            .unwrap()
            .unwrap_or_else(|| panic!("lease {attempt} of the run"));
        assert_eq!(run.turn_identity["requesterName"], "Participant");
        lapse(&pool, &run_id).await;
    }
    assert!(
        lease_canary_run(&pool, RUNNER, &run_id)
            .await
            .unwrap()
            .is_none(),
        "a run past its last attempt is not leased again"
    );
    let (_, body) = send(&app, "GET", card, &token, None).await;
    assert_eq!(body["build"]["status"], "building", "{body}");

    assert!(fail_exhausted_runs(&pool).await.unwrap() >= 1);
    let (status, error_code, attempts): (String, Option<String>, i32) = query_as(
        "SELECT status, error_code, cloud_lease_attempts FROM cloud_agent_fallback_runs \
         WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (status.as_str(), error_code.as_deref(), attempts),
        (
            "failed",
            Some(EXHAUSTED_ERROR_CODE),
            MAX_CLOUD_LEASE_ATTEMPTS
        )
    );
    let (_, body) = send(&app, "GET", card, &token, None).await;
    assert_eq!(
        body["build"],
        json!({"status": "failed", "errorCode": EXHAUSTED_ERROR_CODE, "unreadLinks": []})
    );
    // A later pass finds nothing left to fail for this run, and a new build
    // can start.
    fail_exhausted_runs(&pool).await.unwrap();
    let (status, body) = send(
        &app,
        "POST",
        &format!("{card}/build"),
        &token,
        Some(json!({"notes": "My work."})),
    )
    .await;
    assert_eq!(status, 202, "{body}");
}

#[tokio::test]
async fn a_live_lease_is_never_failed_by_the_sweep() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (member, token) = signed_in(&pool, "Live").await;
    let (status, _) = send(
        &app,
        "POST",
        "/v1/cloud/common-ground/card/build",
        &token,
        Some(json!({"notes": "My work."})),
    )
    .await;
    assert_eq!(status, 202);
    let (run_id,): (String,) =
        query_as("SELECT active_run_id FROM cloud_common_ground_cards WHERE account_id = $1")
            .bind(&member)
            .fetch_one(&pool)
            .await
            .unwrap();
    for attempt in 1..=MAX_CLOUD_LEASE_ATTEMPTS {
        lease_canary_run(&pool, &format!("{RUNNER}:{attempt}"), &run_id)
            .await
            .unwrap()
            .unwrap();
        if attempt < MAX_CLOUD_LEASE_ATTEMPTS {
            lapse(&pool, &run_id).await;
        }
    }
    // The last lease is still live: its runner may yet finish the run.
    fail_exhausted_runs(&pool).await.unwrap();
    let (status,): (String,) =
        query_as("SELECT status FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "leased");
}
