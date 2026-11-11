//! Counts the statements repeated authenticated requests cost. Needs the
//! `pg_stat_statements` extension (with `track = all`) on a disposable
//! database, so it is ignored by default. Run it by hand, alone:
//!
//! `cargo test -p kordi-cloud-server --lib statement_count -- --ignored --nocapture`
//!
//! The listener's own heartbeat statements are left out of the count.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use tower::ServiceExt;
use uuid::Uuid;

use crate::events::EventBus;
use crate::server::ServerState;

const REQUESTS: usize = 100;

#[tokio::test]
#[ignore = "needs pg_stat_statements on a disposable database; run by hand"]
async fn count_statements_for_repeated_authenticated_requests() {
    // Default instance: no admission policy, personal organization.
    // Production-like: verified-email admission and a team organization
    // claim. Each with and without a live listener (the cache is bypassed
    // without one, so every request takes the database lookup).
    for production_like in [false, true] {
        for listen in [false, true] {
            count(production_like, listen).await;
        }
    }
}

async fn count(production_like: bool, listen: bool) {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        return;
    };
    let pool = crate::pg::init_pool(&url).await.expect("init test pool");

    let suffix = Uuid::new_v4().simple().to_string();
    let account_id = format!("acct_count_{suffix}");
    let device_id = format!("dev_count_{suffix}");
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, avatar_source, \
          avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at, \
          ai_consent_status) \
         VALUES ($1, 'Count', $2, $3, $3, 'generated', 'lorelei', $1, 'fixture', 1, $3, 'allowed')",
    )
    .bind(&account_id)
    .bind(format!("{account_id}@example.test"))
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, \
         created_at, last_seen_at) VALUES ($1, $2, 'Count device', $3, $4, $4)",
    )
    .bind(&device_id)
    .bind(&account_id)
    .bind(format!("legacy:{suffix}"))
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();
    let session = crate::auth::session::issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    let token = session.plaintext_token;
    let mut state = ServerState::new(pool.clone(), EventBus::noop());
    if production_like {
        let email = format!("{account_id}@example.test");
        query("UPDATE cloud_accounts SET primary_email_verified_at = $1 WHERE account_id = $2")
            .bind(&now)
            .bind(&account_id)
            .execute(&pool)
            .await
            .unwrap();
        state = state.with_admission(crate::auth::admission::AdmissionPolicy::synthetic(
            crate::auth::admission::AdmissionMode::ApprovedTesters,
            Vec::new(),
            [email].into_iter().collect(),
        ));
        let organization_id = format!("org_count_{suffix}");
        query(
            "INSERT INTO cloud_organizations (organization_id, name, kind, created_by_account_id) \
             VALUES ($1, 'Count team', 'team', $2)",
        )
        .bind(&organization_id)
        .bind(&account_id)
        .execute(&pool)
        .await
        .unwrap();
        query(
            "INSERT INTO cloud_organization_members (organization_id, account_id, role) \
             VALUES ($1, $2, 'owner')",
        )
        .bind(&organization_id)
        .bind(&account_id)
        .execute(&pool)
        .await
        .unwrap();
        query("UPDATE cloud_refresh_tokens SET organization_id = $1 WHERE token_id = $2")
            .bind(&organization_id)
            .bind(&session.token_id)
            .execute(&pool)
            .await
            .unwrap();
    }
    let state = Arc::new(state);
    // A live notification listener, as every production replica has; the
    // session lookup cache is bypassed without one.
    if listen {
        crate::chat_sync::realtime::spawn_wake_listener(
            url.clone(),
            state.chat_sync_wakes().clone(),
            state.session_signals().clone(),
            state.document_rooms().clone(),
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !state.session_signals().lookup_cache().is_live() {
            assert!(
                std::time::Instant::now() < deadline,
                "the listener becomes live"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
    let app = crate::server::router(state.clone());

    let get = |token: &str| {
        Request::builder()
            .uri("/v1/cloud/auth/me")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    let warm = app.clone().oneshot(get(&token)).await.unwrap();
    assert_eq!(warm.status(), StatusCode::OK);

    query("SELECT pg_stat_statements_reset()")
        .execute(&pool)
        .await
        .unwrap();
    for _ in 0..REQUESTS {
        let response = app.clone().oneshot(get(&token)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let rows: Vec<(i64, String)> = query_as(
        "SELECT calls, regexp_replace(query, '\\s+', ' ', 'g') FROM pg_stat_statements \
         WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) \
           AND query NOT ILIKE '%pg_stat_statements%' \
           AND query NOT ILIKE '%pg_notify%' AND query NOT ILIKE 'LISTEN %' \
         ORDER BY calls DESC, query",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let total: i64 = rows.iter().map(|(calls, _)| calls).sum();
    let scenario = format!(
        "{}, {}",
        if production_like {
            "admission + team claim"
        } else {
            "default"
        },
        if listen {
            "live listener"
        } else {
            "no listener (cache bypassed)"
        }
    );
    println!(
        "{scenario}: {REQUESTS} authenticated GET /v1/cloud/auth/me requests: {total} statements"
    );
    for (calls, text) in rows {
        let text: String = text.chars().take(160).collect();
        println!("{calls:>6}  {text}");
    }
}
