//! Timezone name validation that agrees with PostgreSQL.
//!
//! Validated names later feed SQL `AT TIME ZONE` and date math, so they must
//! be exactly the names the database accepts. Querying `pg_timezone_names`
//! parses the whole timezone database on every call, so the names are loaded
//! once per process and checked in memory afterwards.

use std::collections::HashSet;
use std::future::Future;

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use tokio::sync::OnceCell;

static TIMEZONE_NAMES: OnceCell<HashSet<String>> = OnceCell::const_new();

/// Whether PostgreSQL accepts `zone` as a timezone name.
pub(super) async fn valid_timezone(pool: &PgPool, zone: &str) -> Result<bool, sqlx_core::Error> {
    valid_with(&TIMEZONE_NAMES, pool, zone, || load_names(pool)).await
}

/// Checks `zone` against the names in `cache`, loading them with `load` on
/// first use. If loading fails, asks the database directly so a validation
/// never rejects a name only because the cache is unavailable; the next call
/// tries to load the cache again.
async fn valid_with<Load, Loading>(
    cache: &OnceCell<HashSet<String>>,
    pool: &PgPool,
    zone: &str,
    load: Load,
) -> Result<bool, sqlx_core::Error>
where
    Load: FnOnce() -> Loading,
    Loading: Future<Output = Result<HashSet<String>, sqlx_core::Error>>,
{
    match cache.get_or_try_init(load).await {
        Ok(names) => Ok(names.contains(zone)),
        Err(_) => query_one(pool, zone).await,
    }
}

async fn load_names(pool: &PgPool) -> Result<HashSet<String>, sqlx_core::Error> {
    let rows: Vec<(String,)> = query_as("SELECT name FROM pg_timezone_names")
        .fetch_all(pool)
        .await?;
    if rows.is_empty() {
        // An empty list would reject every name; keep asking per call.
        return Err(sqlx_core::Error::RowNotFound);
    }
    Ok(rows.into_iter().map(|(name,)| name).collect())
}

async fn query_one(pool: &PgPool, zone: &str) -> Result<bool, sqlx_core::Error> {
    query_as::<_, (bool,)>("SELECT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=$1)")
        .bind(zone)
        .fetch_one(pool)
        .await
        .map(|row| row.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const VALID: &[&str] = &["America/Los_Angeles", "UTC", "Asia/Riyadh", "Europe/London"];
    const INVALID: &[&str] = &["Unknown/Timezone", "", "utc ", "america/los_angeles"];

    async fn pool() -> PgPool {
        let url = std::env::var("KORDI_DIGEST_TEST_DATABASE_URL")
            .expect("isolated test database required");
        sqlx_postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("connect isolated database")
    }

    #[tokio::test]
    #[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
    async fn timezone_names_load_once_and_match_postgres() {
        let pool = pool().await;
        let cache = OnceCell::new();
        let loads = AtomicUsize::new(0);
        for _ in 0..25 {
            for zone in VALID {
                let valid = valid_with(&cache, &pool, zone, || {
                    loads.fetch_add(1, Ordering::SeqCst);
                    load_names(&pool)
                })
                .await
                .unwrap();
                assert!(valid, "{zone} should be accepted");
                assert!(query_one(&pool, zone).await.unwrap());
            }
            for zone in INVALID {
                let valid = valid_with(&cache, &pool, zone, || {
                    loads.fetch_add(1, Ordering::SeqCst);
                    load_names(&pool)
                })
                .await
                .unwrap();
                assert!(!valid, "{zone:?} should be rejected");
                assert!(!query_one(&pool, zone).await.unwrap());
            }
        }
        assert_eq!(loads.load(Ordering::SeqCst), 1, "names load only once");
        assert!(valid_timezone(&pool, "Asia/Riyadh").await.unwrap());
        assert!(!valid_timezone(&pool, "Unknown/Timezone").await.unwrap());
    }

    #[tokio::test]
    #[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
    async fn a_failed_load_falls_back_to_asking_postgres() {
        let pool = pool().await;
        let cache = OnceCell::new();
        let failing = || async { Err(sqlx_core::Error::PoolTimedOut) };
        assert!(valid_with(&cache, &pool, "America/Los_Angeles", failing)
            .await
            .unwrap());
        assert!(!valid_with(&cache, &pool, "Unknown/Timezone", failing)
            .await
            .unwrap());
        assert!(cache.get().is_none(), "a failed load is retried later");
        assert!(valid_with(&cache, &pool, "UTC", || load_names(&pool))
            .await
            .unwrap());
        assert!(cache.get().is_some());
    }
}
