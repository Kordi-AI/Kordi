use super::*;

#[tokio::test]
async fn diagnostics_distinguish_cache_use_and_invalidation_causes() {
    let cache = SessionLookupCache::default();
    let pool = sqlx_postgres::PgPoolOptions::new()
        .connect_lazy("postgresql://localhost/synthetic")
        .unwrap();
    pool.close().await;
    let token = "kordi_cs_synthetic-metrics";
    assert!(cache.lookup(&pool, token).await.is_err());
    cache.set_listener_connected(true);
    cache.notification_received();
    assert!(cache.lookup(&pool, token).await.is_err());
    let now = Instant::now();
    let hash = crate::auth::session::hash_session_token(token);
    fill(
        &cache,
        &hash,
        &lookup("synthetic", "token", chrono::Duration::days(1)),
        now,
    );
    assert!(cache.lookup(&pool, token).await.unwrap().is_some());
    cache.evict_after_mutation("synthetic");
    cache.evict_account("synthetic");
    cache.set_listener_connected(false);
    let metrics = cache.metrics().snapshot();
    assert_eq!(metrics["counters"]["cache_bypass"], 1);
    assert_eq!(metrics["counters"]["cache_miss"], 1);
    assert_eq!(metrics["counters"]["cache_hit"], 1);
    assert_eq!(metrics["counters"]["lookup_error"], 2);
    assert_eq!(metrics["counters"]["mutation_eviction"], 1);
    assert_eq!(metrics["counters"]["signal_eviction"], 1);
    assert_eq!(metrics["counters"]["listener_clear"], 2);
    assert_eq!(metrics["pool_wait"]["count"], 2);
    assert_eq!(metrics["database_lookup"]["count"], 0);
}
