use super::*;

#[test]
fn activity_freshness_respects_the_minute_boundary_and_unknown_values() {
    let now = Utc::now();
    assert!(device_activity_is_fresh(Some(now), now));
    assert!(device_activity_is_fresh(
        Some(now + Duration::minutes(1)),
        now
    ));
    assert!(device_activity_is_fresh(
        Some(now - Duration::minutes(1)),
        now
    ));
    assert!(!device_activity_is_fresh(
        Some(now - Duration::minutes(1) - Duration::nanoseconds(1)),
        now
    ));
    assert!(!device_activity_is_fresh(None, now));
}

async fn last_seen(pool: &PgPool, device: &str) -> String {
    let (seen,): (String,) =
        query_as("SELECT last_seen_at FROM cloud_devices WHERE device_id = $1")
            .bind(device)
            .fetch_one(pool)
            .await
            .unwrap();
    seen
}

async fn age(pool: &PgPool, device: &str) -> DateTime<Utc> {
    let stale = Utc::now() - Duration::minutes(2);
    query("UPDATE cloud_devices SET last_seen_at = $1 WHERE device_id = $2")
        .bind(stale.to_rfc3339())
        .bind(device)
        .execute(pool)
        .await
        .unwrap();
    stale
}

#[tokio::test]
async fn fresh_activity_avoids_database_access_and_stale_activity_keeps_guards() {
    let Some(pool) = pool().await else { return };
    let (account, device) = account_with_device(&pool).await;
    let session = issue_session(&pool, &account, &device, 30).await.unwrap();
    let hash = hash_session_token(&session.plaintext_token);
    let lookup = lookup_session_by_hash(&pool, &hash, Utc::now())
        .await
        .unwrap()
        .unwrap();
    assert!(lookup.device_last_seen_at.is_some());
    // A closed pool proves that a fresh observation sends no statement.
    let closed = sqlx_postgres::PgPoolOptions::new()
        .connect_lazy(&std::env::var("DATABASE_URL").unwrap())
        .unwrap();
    closed.close().await;
    touch_device_activity_if_stale(&closed, &account, &device, lookup.device_last_seen_at)
        .await
        .unwrap();
    assert!(
        touch_device_activity_if_stale(&closed, &account, &device, None)
            .await
            .is_err()
    );

    let stale = age(&pool, &device).await;
    let before = Utc::now();
    let (left, right) = tokio::join!(
        touch_device_activity_if_stale(&pool, &account, &device, Some(stale)),
        touch_device_activity_if_stale(&pool, &account, &device, Some(stale)),
    );
    left.unwrap();
    right.unwrap();
    let refreshed = last_seen(&pool, &device).await;
    assert!(DateTime::parse_from_rfc3339(&refreshed).unwrap() >= before);
    touch_device_activity_if_stale(&pool, &account, &device, Some(stale))
        .await
        .unwrap();
    assert_eq!(last_seen(&pool, &device).await, refreshed);

    let stale = age(&pool, &device).await;
    touch_device_activity_if_stale(&pool, "another-account", &device, Some(stale))
        .await
        .unwrap();
    assert_eq!(last_seen(&pool, &device).await, stale.to_rfc3339());
    query("UPDATE cloud_devices SET revoked_at = $1 WHERE device_id = $2")
        .bind(Utc::now().to_rfc3339())
        .bind(&device)
        .execute(&pool)
        .await
        .unwrap();
    touch_device_activity_if_stale(&pool, &account, &device, Some(stale))
        .await
        .unwrap();
    assert_eq!(last_seen(&pool, &device).await, stale.to_rfc3339());
}

#[tokio::test]
async fn activity_lookup_handles_offsets_and_unknown_timestamps() {
    let Some(pool) = pool().await else { return };
    let (account, device) = account_with_device(&pool).await;
    let session = issue_session(&pool, &account, &device, 30).await.unwrap();
    let hash = hash_session_token(&session.plaintext_token);
    let now = Utc::now();
    let offset = now.with_timezone(&chrono::FixedOffset::east_opt(5 * 3600).unwrap());
    for (stored, expected) in [
        (offset.to_rfc3339(), Some(now)),
        ("unknown".to_string(), None),
    ] {
        query("UPDATE cloud_devices SET last_seen_at = $1 WHERE device_id = $2")
            .bind(stored)
            .bind(&device)
            .execute(&pool)
            .await
            .unwrap();
        let found = lookup_session_by_hash(&pool, &hash, Utc::now())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.device_last_seen_at, expected);
    }
    age(&pool, &device).await;
    touch_device_activity_if_stale(&pool, &account, &device, None)
        .await
        .unwrap();
    assert!(DateTime::parse_from_rfc3339(&last_seen(&pool, &device).await).unwrap() > now);
}
