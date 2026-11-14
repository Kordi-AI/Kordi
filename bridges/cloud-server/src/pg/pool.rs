//! Postgres pool + migration runner.
//!
//! `init_pool` opens a `sqlx::PgPool` against the supplied connection
//! string and applies every embedded migration exactly once. Applied
//! versions are tracked in `cloud_schema_versions` (independent of the
//! legacy `schema_versions` table the rusqlite path uses, so the two
//! paths never share state).
//!
//! Uses `sqlx-postgres` and `sqlx-core` directly (no `sqlx` umbrella) so
//! that the workspace dep graph doesn't pull `sqlx-sqlite`, which would
//! conflict with `bridges/cli`'s `rusqlite` at the `libsqlite3-sys`
//! `links` layer. SQL is embedded via `include_str!()` so the runtime
//! image doesn't need the `migrations/` directory shipped alongside.

use std::fmt;

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgConnectOptions, PgPool, PgPoolOptions};

mod embedded;
mod embedded_latest;
mod embedded_recent;
mod migrate;
mod migration_entry;
use embedded::EMBEDDED_MIGRATIONS;

#[derive(Clone, Copy)]
pub(super) struct EmbeddedMigration {
    pub(super) version: i64,
    pub(super) description: &'static str,
    pub(super) sql: &'static str,
}
pub(crate) use migrate::apply_migrations;

#[cfg(test)]
mod upgrade_tests;

#[derive(Debug)]
pub enum PgPoolError {
    Connect(sqlx_core::Error),
    Migrate(sqlx_core::Error),
}

impl fmt::Display for PgPoolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Connect(err) => write!(f, "connect to postgres: {err}"),
            Self::Migrate(err) => write!(f, "apply migrations: {err}"),
        }
    }
}

impl std::error::Error for PgPoolError {}

/// Connections the pool may open. A busy room polls results from every
/// member's device, so the old fixed 10 starved requests under load.
const MAX_CONNECTIONS_ENV: &str = "KORDI_DATABASE_MAX_CONNECTIONS";
const DEFAULT_MAX_CONNECTIONS: u32 = 30;
/// Seconds a request waits for a free connection before it fails.
const ACQUIRE_TIMEOUT_ENV: &str = "KORDI_DATABASE_ACQUIRE_TIMEOUT_SECS";
const DEFAULT_ACQUIRE_TIMEOUT_SECS: u32 = 5;

/// A positive whole number from `name`, else `default`.
fn env_number(name: &str, default: u32) -> u32 {
    parse_positive(std::env::var(name).ok().as_deref(), default)
}

fn parse_positive(value: Option<&str>, default: u32) -> u32 {
    value
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

/// Open a `PgPool` against `database_url`, configure conservative defaults,
/// and apply every embedded migration exactly once. Returns the pool ready
/// for handler use.
///
/// `database_url` is a standard libpq connection string, e.g.
/// `postgresql://kordi:<password>@postgres.kordi-cloud.svc.cluster.local:5432/kordi_cloud`.
pub async fn init_pool(database_url: &str) -> Result<PgPool, PgPoolError> {
    let options: PgConnectOptions = database_url.parse().map_err(PgPoolError::Connect)?;

    let pool = PgPoolOptions::new()
        .max_connections(env_number(MAX_CONNECTIONS_ENV, DEFAULT_MAX_CONNECTIONS))
        .min_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(u64::from(env_number(
            ACQUIRE_TIMEOUT_ENV,
            DEFAULT_ACQUIRE_TIMEOUT_SECS,
        ))))
        .idle_timeout(std::time::Duration::from_secs(60))
        .connect_with(options)
        .await
        .map_err(PgPoolError::Connect)?;

    apply_migrations(&pool).await?;
    Ok(pool)
}

#[cfg(test)]
mod settings_tests {
    use super::parse_positive;

    #[test]
    fn pool_settings_fall_back_to_the_default() {
        assert_eq!(parse_positive(None, 30), 30);
        assert_eq!(parse_positive(Some(""), 30), 30);
        assert_eq!(parse_positive(Some("0"), 30), 30);
        assert_eq!(parse_positive(Some("abc"), 30), 30);
        assert_eq!(parse_positive(Some(" 64 "), 30), 64);
    }
}
