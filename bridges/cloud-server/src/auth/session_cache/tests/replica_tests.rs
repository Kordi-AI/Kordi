//! Invalidation across independent server replicas.

use super::*;

/// One server replica with its own state and notification listener, like
/// the API processes in production.
async fn replica(pool: &PgPool) -> (Arc<ServerState>, axum::Router) {
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    crate::chat_sync::realtime::spawn_wake_listener(
        std::env::var("DATABASE_URL").unwrap(),
        state.chat_sync_wakes().clone(),
        state.session_signals().clone(),
        state.document_rooms().clone(),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while !state.session_signals().lookup_cache().is_live() {
        assert!(Instant::now() < deadline, "the listener becomes live");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let app = crate::server::router(state.clone());
    (state, app)
}

/// Waits until `state`'s listener has handled every notification committed
/// so far (notifications arrive in commit order), so signals from fixture
/// writes cannot evict entries a test is about to check.
async fn settle(state: &ServerState, pool: &PgPool) {
    let barrier = format!("acct_barrier_{}", Uuid::new_v4().simple());
    let mut subscription = state.session_signals().subscribe(&barrier, "dev", None);
    query("SELECT cloud_notify_session_signal($1, NULL, NULL, 'recheck')")
        .bind(&barrier)
        .execute(pool)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), subscription.recv())
        .await
        .expect("the listener catches up");
}

async fn me(app: &axum::Router, token: &str) -> StatusCode {
    let request = Request::builder()
        .uri("/v1/cloud/auth/me")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    app.clone().oneshot(request).await.unwrap().status()
}

/// Warms both replicas' caches with `token` and checks they hold it.
async fn cached_on_both(pool: &PgPool, replicas: &[(Arc<ServerState>, axum::Router)], token: &str) {
    for (state, app) in replicas {
        settle(state, pool).await;
        assert_eq!(me(app, token).await, StatusCode::OK);
        assert_eq!(me(app, token).await, StatusCode::OK);
        let cache = state.session_signals().lookup_cache();
        let hash = crate::auth::session::hash_session_token(token);
        assert!(
            cache.state().entries.contains_key(&hash),
            "the session is cached"
        );
    }
}

/// Every replica rejects `token` within moments of a change committed
/// anywhere, without waiting for the cache lifetime.
async fn rejected_on_both(replicas: &[(Arc<ServerState>, axum::Router)], token: &str) {
    for (_, app) in replicas {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let status = me(app, token).await;
            if status == StatusCode::UNAUTHORIZED {
                break;
            }
            // Until the signal arrives the cached session is accepted; for a
            // deleted account the handler then finds no account.
            assert!(
                [StatusCode::OK, StatusCode::NOT_FOUND].contains(&status),
                "{status}"
            );
            assert!(Instant::now() < deadline, "the change reaches the replica");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

#[tokio::test]
async fn revocations_reach_every_replica_cache() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let replicas = [replica(&pool).await, replica(&pool).await];

    // Sign-out through the first replica: it rejects the token on the very
    // next request, and the second replica follows through the signal.
    let (_, _, _, token) = signed_in(&pool).await;
    cached_on_both(&pool, &replicas, &token).await;
    let logout = Request::builder()
        .method("POST")
        .uri("/v1/cloud/auth/logout")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = replicas[0].1.clone().oneshot(logout).await.unwrap();
    assert!(response.status().is_success(), "{}", response.status());
    assert_eq!(me(&replicas[0].1, &token).await, StatusCode::UNAUTHORIZED);
    rejected_on_both(&replicas, &token).await;

    // A session revoked by any other path.
    let (_, _, token_id, token) = signed_in(&pool).await;
    cached_on_both(&pool, &replicas, &token).await;
    crate::auth::session::revoke_session(&pool, &token_id)
        .await
        .unwrap();
    rejected_on_both(&replicas, &token).await;

    // A revoked device.
    let (_, device_id, _, token) = signed_in(&pool).await;
    cached_on_both(&pool, &replicas, &token).await;
    query("UPDATE cloud_devices SET revoked_at = $1 WHERE device_id = $2")
        .bind(Utc::now().to_rfc3339())
        .bind(&device_id)
        .execute(&pool)
        .await
        .unwrap();
    rejected_on_both(&replicas, &token).await;

    // A deleted account.
    let (account_id, _, _, token) = signed_in(&pool).await;
    cached_on_both(&pool, &replicas, &token).await;
    query("DELETE FROM cloud_accounts WHERE account_id = $1")
        .bind(&account_id)
        .execute(&pool)
        .await
        .unwrap();
    rejected_on_both(&replicas, &token).await;
}

#[tokio::test]
async fn organization_changes_reach_every_replica_cache() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let replicas = [replica(&pool).await, replica(&pool).await];
    let (account_id, _, token_id, token) = signed_in(&pool).await;
    let organization_id = format!("org_cache_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_organizations (organization_id, name, kind, created_by_account_id) \
         VALUES ($1, 'Cache team', 'team', $2)",
    )
    .bind(&organization_id)
    .bind(&account_id)
    .execute(&pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_organization_members (organization_id, account_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(&organization_id)
    .bind(&account_id)
    .execute(&pool)
    .await
    .unwrap();

    let claim = |expected_claim: Option<&str>, expected_active: bool| {
        let token = token.clone();
        let pool = pool.clone();
        let expected_claim = expected_claim.map(ToString::to_string);
        let replicas = replicas.clone();
        async move {
            for (state, _) in &replicas {
                let cache = state.session_signals().lookup_cache();
                let deadline = Instant::now() + Duration::from_secs(2);
                loop {
                    let (found, _) = cache.lookup(&pool, &token).await.unwrap().unwrap();
                    let organization = &found.row.organization;
                    if organization.claimed == expected_claim
                        && organization.claim_active == expected_active
                    {
                        // Signals still in flight may evict it once more.
                        settle(state, &pool).await;
                        cache.lookup(&pool, &token).await.unwrap().unwrap();
                        break;
                    }
                    assert!(Instant::now() < deadline, "the change reaches the replica");
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                let (found, source) = cache.lookup(&pool, &token).await.unwrap().unwrap();
                assert_eq!(source, LookupSource::Cache, "the new answer is cached");
                assert_eq!(found.row.organization.claimed, expected_claim);
                assert_eq!(found.row.organization.claim_active, expected_active);
            }
        }
    };
    claim(None, false).await;

    // Switching the session's organization.
    query("UPDATE cloud_refresh_tokens SET organization_id = $1 WHERE token_id = $2")
        .bind(&organization_id)
        .bind(&token_id)
        .execute(&pool)
        .await
        .unwrap();
    claim(Some(&organization_id), true).await;

    // Leaving the organization ends the claim's membership.
    query("DELETE FROM cloud_organization_members WHERE organization_id = $1 AND account_id = $2")
        .bind(&organization_id)
        .bind(&account_id)
        .execute(&pool)
        .await
        .unwrap();
    claim(Some(&organization_id), false).await;

    // Rejoining with a membership that has already expired.
    query(
        "INSERT INTO cloud_organization_members (organization_id, account_id, role, expires_at) \
         VALUES ($1, $2, 'member', now() - interval '1 minute')",
    )
    .bind(&organization_id)
    .bind(&account_id)
    .execute(&pool)
    .await
    .unwrap();
    claim(Some(&organization_id), false).await;
    query(
        "UPDATE cloud_organization_members SET expires_at = NULL \
         WHERE organization_id = $1 AND account_id = $2",
    )
    .bind(&organization_id)
    .bind(&account_id)
    .execute(&pool)
    .await
    .unwrap();
    claim(Some(&organization_id), true).await;

    // Deleting the organization empties the claim.
    query("DELETE FROM cloud_organizations WHERE organization_id = $1")
        .bind(&organization_id)
        .execute(&pool)
        .await
        .unwrap();
    claim(None, false).await;
}

#[tokio::test]
async fn admission_changes_reach_every_replica_cache() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let replicas = [replica(&pool).await, replica(&pool).await];
    let (account_id, _, _, token) = signed_in(&pool).await;
    for (state, _) in &replicas {
        settle(state, &pool).await;
        let cache = state.session_signals().lookup_cache();
        cache.lookup(&pool, &token).await.unwrap().unwrap();
        let (found, source) = cache.lookup(&pool, &token).await.unwrap().unwrap();
        assert_eq!(source, LookupSource::Cache);
        assert_eq!(found.account.as_ref().map(|facts| facts.1), Some(false));
    }
    query("UPDATE cloud_accounts SET primary_email_verified_at = $1 WHERE account_id = $2")
        .bind(Utc::now().to_rfc3339())
        .bind(&account_id)
        .execute(&pool)
        .await
        .unwrap();
    for (state, _) in &replicas {
        let cache = state.session_signals().lookup_cache();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let (found, _) = cache.lookup(&pool, &token).await.unwrap().unwrap();
            if found.account.as_ref().map(|facts| facts.1) == Some(true) {
                break;
            }
            assert!(Instant::now() < deadline, "the change reaches the replica");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

#[tokio::test]
async fn earlier_expiry_with_a_later_text_value_evicts_every_replica() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let replicas = [replica(&pool).await, replica(&pool).await];
    let (_, _, token_id, token) = signed_in(&pool).await;
    let original = Utc::now() + chrono::Duration::hours(2);
    let earlier = original - chrono::Duration::hours(1);
    let earlier_text = earlier
        .with_timezone(&chrono::FixedOffset::east_opt(14 * 3600).unwrap())
        .to_rfc3339();
    assert!(earlier_text > original.to_rfc3339());
    query("UPDATE cloud_refresh_tokens SET expires_at = $1 WHERE token_id = $2")
        .bind(original.to_rfc3339())
        .bind(&token_id)
        .execute(&pool)
        .await
        .unwrap();
    for (state, _) in &replicas {
        settle(state, &pool).await;
        let cache = state.session_signals().lookup_cache();
        cache.lookup(&pool, &token).await.unwrap().unwrap();
        assert_eq!(
            cache.lookup(&pool, &token).await.unwrap().unwrap().1,
            LookupSource::Cache
        );
    }
    query("UPDATE cloud_refresh_tokens SET expires_at = $1 WHERE token_id = $2")
        .bind(earlier_text)
        .bind(&token_id)
        .execute(&pool)
        .await
        .unwrap();
    for (state, _) in &replicas {
        settle(state, &pool).await;
        let (found, source) = state
            .session_signals()
            .lookup_cache()
            .lookup(&pool, &token)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(source, LookupSource::Database);
        assert_eq!(found.row.expires_at, earlier);
    }
}
