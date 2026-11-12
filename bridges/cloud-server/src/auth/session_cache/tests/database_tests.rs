//! Cache database lookups and organization equivalence.

use super::*;

#[tokio::test]
async fn a_cache_hit_avoids_the_database() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let (account_id, _, token_id, token) = signed_in(&pool).await;
    let cache = manually_live();
    let (first, source) = cache.lookup(&pool, &token).await.unwrap().unwrap();
    assert_eq!(source, LookupSource::Database);
    assert_eq!(first.row.account_id, account_id);
    assert_eq!(first.row.token_id, token_id);

    // With the database gone, the cached answer is still served.
    pool.close().await;
    let (second, source) = cache.lookup(&pool, &token).await.unwrap().unwrap();
    assert_eq!(source, LookupSource::Cache);
    assert_eq!(second, first);
    // Unknown tokens are never answered from the cache.
    assert!(cache.lookup(&pool, "kordi_cs_not-a-session").await.is_err());
    assert!(cache
        .lookup(&pool, "not-a-session")
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn a_disconnected_listener_means_no_caching() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let (_, _, _, token) = signed_in(&pool).await;
    let cache = SessionLookupCache::default();
    cache.set_listener_connected(true);
    cache.notification_received();
    cache.set_listener_connected(false);
    let (_, source) = cache.lookup(&pool, &token).await.unwrap().unwrap();
    assert_eq!(source, LookupSource::Database);
    assert_eq!(cache.len(), 0);
    pool.close().await;
    assert!(
        cache.lookup(&pool, &token).await.is_err(),
        "every lookup goes to the database"
    );
}

#[tokio::test]
async fn an_expired_token_is_rejected_even_when_cached() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let (account_id, device_id, _, _) = signed_in(&pool).await;
    let token = crate::auth::session::random_token_plaintext();
    let expires_at = Utc::now() + chrono::Duration::milliseconds(1500);
    query(
        "INSERT INTO cloud_refresh_tokens \
         (token_id, account_id, device_id, token_hash, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(format!("cs_{}", Uuid::new_v4().simple()))
    .bind(&account_id)
    .bind(&device_id)
    .bind(crate::auth::session::hash_session_token(&token))
    .bind(Utc::now().to_rfc3339())
    .bind(expires_at.to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();

    let cache = manually_live();
    assert_eq!(
        cache.lookup(&pool, &token).await.unwrap().unwrap().1,
        LookupSource::Database
    );
    assert_eq!(
        cache.lookup(&pool, &token).await.unwrap().unwrap().1,
        LookupSource::Cache
    );
    let wait = (expires_at - Utc::now()).to_std().unwrap_or_default();
    tokio::time::sleep(wait + Duration::from_millis(100)).await;
    cache.notification_received();
    assert!(
        cache.lookup(&pool, &token).await.unwrap().is_none(),
        "the session expired inside the cache lifetime"
    );
}

#[tokio::test]
async fn the_collapsed_lookup_matches_the_organization_columns() {
    let Some(pool) = test_pool().await else {
        return;
    };
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
    let check = || async {
        let found = crate::auth::session::lookup_session(&pool, &token)
            .await
            .unwrap()
            .unwrap();
        let expected = crate::organizations::requests::load_for_session(&pool, &token_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.organization, expected);
        found.organization
    };
    assert!(check().await.personal.is_some());
    query("UPDATE cloud_refresh_tokens SET organization_id = $1 WHERE token_id = $2")
        .bind(&organization_id)
        .bind(&token_id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(!check().await.claim_active, "not a member yet");
    query(
        "INSERT INTO cloud_organization_members (organization_id, account_id, role, expires_at) \
         VALUES ($1, $2, 'member', now() + interval '1 hour')",
    )
    .bind(&organization_id)
    .bind(&account_id)
    .execute(&pool)
    .await
    .unwrap();
    assert!(check().await.claim_active);
    query(
        "UPDATE cloud_organization_members SET expires_at = now() - interval '1 second' \
         WHERE organization_id = $1 AND account_id = $2",
    )
    .bind(&organization_id)
    .bind(&account_id)
    .execute(&pool)
    .await
    .unwrap();
    assert!(!check().await.claim_active, "the membership expired");
}
