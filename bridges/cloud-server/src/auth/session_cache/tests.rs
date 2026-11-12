//! Session lookup cache: liveness gating, expiry, eviction, bounds, and
//! revocation across two server replicas that share one database.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono::Utc;
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use super::{LookupSource, Probe, SessionLookupCache, Ticket};
use crate::auth::session::{CloudSessionRow, SessionLookup, SessionOrganization};
use crate::events::EventBus;
use crate::server::ServerState;

const TTL: Duration = Duration::from_secs(30);
const WINDOW: Duration = Duration::from_secs(15);

fn lookup(account_id: &str, token_id: &str, expires_in: chrono::Duration) -> SessionLookup {
    SessionLookup {
        device_last_seen_at: Some(Utc::now()),
        row: CloudSessionRow {
            token_id: token_id.to_string(),
            account_id: account_id.to_string(),
            device_id: format!("dev_{account_id}"),
            expires_at: Utc::now() + expires_in,
            sliding_expiry: true,
            organization: SessionOrganization {
                claimed: None,
                personal: Some(format!("org_{account_id}")),
                claim_active: false,
            },
        },
        app_sign_in_id: None,
        account: Some((Some(format!("{account_id}@example.test")), true)),
        membership_expires_at: None,
    }
}

fn live_cache(capacity: usize, now: Instant) -> SessionLookupCache {
    let cache = SessionLookupCache::with_limits(TTL, capacity, WINDOW);
    cache.set_listener_connected(true);
    cache.notification_received_at(now);
    cache
}

fn ticket(cache: &SessionLookupCache, hash: &str, now: Instant) -> Option<Ticket> {
    match cache.probe(hash, now, Utc::now()) {
        Probe::Hit(_) => panic!("expected a miss for {hash}"),
        Probe::Miss(ticket) => ticket,
    }
}

fn hit(cache: &SessionLookupCache, hash: &str, now: Instant) -> bool {
    matches!(cache.probe(hash, now, Utc::now()), Probe::Hit(_))
}

fn fill(cache: &SessionLookupCache, hash: &str, found: &SessionLookup, now: Instant) {
    let ticket = ticket(cache, hash, now).expect("the cache is live");
    cache.fill(hash.to_string(), found, ticket, now, Utc::now());
}

#[test]
fn entries_are_served_only_while_the_listener_is_live() {
    let now = Instant::now();
    let found = lookup("acct", "cs_1", chrono::Duration::days(1));

    let cache = SessionLookupCache::with_limits(TTL, 10, WINDOW);
    assert_eq!(ticket(&cache, "h1", now), None, "never connected");
    cache.set_listener_connected(true);
    assert_eq!(
        ticket(&cache, "h1", now),
        None,
        "connected, but no notification has arrived yet"
    );
    cache.notification_received_at(now);
    fill(&cache, "h1", &found, now);
    assert!(hit(&cache, "h1", now + Duration::from_secs(1)));

    // No notification for longer than the window: bypass and empty.
    let quiet = now + WINDOW + Duration::from_secs(1);
    assert_eq!(ticket(&cache, "h1", quiet), None);
    assert_eq!(cache.len(), 0);

    // A disconnect empties the cache, and a reconnect starts empty.
    cache.notification_received_at(quiet);
    fill(&cache, "h1", &found, quiet);
    assert_eq!(cache.len(), 1);
    cache.set_listener_connected(false);
    assert_eq!(cache.len(), 0);
    assert_eq!(ticket(&cache, "h1", quiet), None);
    cache.set_listener_connected(true);
    cache.notification_received_at(quiet);
    assert!(!hit(&cache, "h1", quiet));
}

#[test]
fn a_notification_gap_empties_the_cache_before_it_is_used_again() {
    let now = Instant::now();
    let cache = live_cache(10, now);
    fill(
        &cache,
        "h1",
        &lookup("acct", "cs_1", chrono::Duration::days(1)),
        now,
    );
    // Heartbeats stopped for longer than the window, then resumed, and no
    // request came in meanwhile: signals may have been lost in the gap.
    let later = now + WINDOW + Duration::from_secs(1);
    cache.notification_received_at(later);
    assert!(!hit(&cache, "h1", later));
    assert_eq!(cache.len(), 0);
}

#[test]
fn entries_end_with_the_ttl_the_session_and_the_membership() {
    let now = Instant::now();
    let cache = live_cache(10, now);

    fill(
        &cache,
        "ttl",
        &lookup("a", "cs_ttl", chrono::Duration::days(1)),
        now,
    );
    cache.notification_received_at(now + Duration::from_secs(10));
    cache.notification_received_at(now + Duration::from_secs(20));
    assert!(hit(&cache, "ttl", now + TTL - Duration::from_millis(1)));
    assert!(!hit(&cache, "ttl", now + TTL));

    // A session that expires inside the TTL is not served past its expiry.
    let short = lookup("b", "cs_short", chrono::Duration::milliseconds(300));
    fill(&cache, "short", &short, now);
    assert!(matches!(
        cache.probe("short", now, Utc::now()),
        Probe::Hit(_)
    ));
    assert!(matches!(
        cache.probe("short", now, Utc::now() + chrono::Duration::seconds(1)),
        Probe::Miss(Some(_))
    ));

    // An already expired answer is never cached.
    let expired = lookup("c", "cs_expired", chrono::Duration::seconds(-1));
    fill(&cache, "expired", &expired, now);
    assert!(
        !cache.state().entries.contains_key("expired"),
        "an expired session is not cached"
    );

    // An organization claim is served only until its membership expires.
    let mut claimed = lookup("d", "cs_claim", chrono::Duration::days(1));
    claimed.row.organization.claimed = Some("org_team".to_string());
    claimed.row.organization.claim_active = true;
    claimed.membership_expires_at = Some(Utc::now() + chrono::Duration::seconds(5));
    fill(&cache, "claim", &claimed, now);
    assert!(matches!(
        cache.probe("claim", now, Utc::now()),
        Probe::Hit(_)
    ));
    assert!(matches!(
        cache.probe("claim", now, Utc::now() + chrono::Duration::seconds(6)),
        Probe::Miss(Some(_))
    ));
}

#[test]
fn eviction_is_by_account_and_stops_lookups_in_flight() {
    let now = Instant::now();
    let cache = live_cache(10, now);
    let mine = lookup("acct_a", "cs_a1", chrono::Duration::days(1));
    fill(&cache, "a1", &mine, now);
    fill(
        &cache,
        "a2",
        &lookup("acct_a", "cs_a2", chrono::Duration::days(1)),
        now,
    );
    fill(
        &cache,
        "b1",
        &lookup("acct_b", "cs_b1", chrono::Duration::days(1)),
        now,
    );

    // A lookup starts, a revocation for its account lands while the
    // database answers, and the stale answer must not be cached.
    let in_flight = ticket(&cache, "a3", now).unwrap();
    cache.evict_account("acct_a");
    cache.fill(
        "a3".to_string(),
        &lookup("acct_a", "cs_a3", chrono::Duration::days(1)),
        in_flight,
        now,
        Utc::now(),
    );
    assert!(!hit(&cache, "a1", now));
    assert!(!hit(&cache, "a2", now));
    assert!(!hit(&cache, "a3", now));
    assert!(hit(&cache, "b1", now), "other accounts stay cached");
    assert!(!cache.state().by_account.contains_key("acct_a"));

    // An eviction of another account does not stop this one's lookup.
    let in_flight = ticket(&cache, "b2", now).unwrap();
    cache.evict_account("acct_c");
    let other = lookup("acct_b", "cs_b2", chrono::Duration::days(1));
    cache.fill("b2".to_string(), &other, in_flight, now, Utc::now());
    assert!(hit(&cache, "b2", now));

    // A lookup slower than the fill deadline is not cached.
    let slow = ticket(&cache, "b3", now).unwrap();
    let late = now + super::FILL_DEADLINE + Duration::from_secs(1);
    cache.notification_received_at(now + Duration::from_secs(10));
    cache.notification_received_at(now + Duration::from_secs(20));
    cache.notification_received_at(now + Duration::from_secs(30));
    cache.notification_received_at(now + Duration::from_secs(40));
    cache.notification_received_at(now + Duration::from_secs(50));
    cache.notification_received_at(late);
    let third = lookup("acct_b", "cs_b3", chrono::Duration::days(1));
    cache.fill("b3".to_string(), &third, slow, late, Utc::now());
    assert!(!hit(&cache, "b3", late));
}

#[test]
fn the_cache_is_bounded() {
    let now = Instant::now();
    let cache = live_cache(2, now);
    for (hash, account) in [("h1", "a1"), ("h2", "a2"), ("h3", "a3")] {
        fill(
            &cache,
            hash,
            &lookup(account, hash, chrono::Duration::days(1)),
            now,
        );
    }
    assert_eq!(
        cache.len(),
        2,
        "a full cache of fresh entries takes no more"
    );
    assert!(!hit(&cache, "h3", now));

    // Once entries go stale, a full cache drops them to make room.
    let later = now + TTL + Duration::from_secs(1);
    cache.notification_received_at(now + Duration::from_secs(10));
    cache.notification_received_at(now + Duration::from_secs(20));
    cache.notification_received_at(later);
    fill(
        &cache,
        "h3",
        &lookup("a3", "h3", chrono::Duration::days(1)),
        later,
    );
    assert!(hit(&cache, "h3", later));
    assert_eq!(cache.len(), 1);
}

// Database-backed tests.

async fn test_pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL")
        .ok()
        .filter(|url| !url.trim().is_empty())?;
    Some(crate::pg::init_pool(&url).await.expect("init test pool"))
}

/// An account with one device and one session; returns
/// (account id, device id, token id, plaintext token).
async fn signed_in(pool: &PgPool) -> (String, String, String, String) {
    let suffix = Uuid::new_v4().simple().to_string();
    let account_id = format!("acct_cache_{suffix}");
    let device_id = format!("dev_cache_{suffix}");
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, avatar_source, \
          avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at, \
          ai_consent_status) \
         VALUES ($1, 'Cache', $2, $3, $3, 'generated', 'lorelei', $1, 'fixture', 1, $3, 'allowed')",
    )
    .bind(&account_id)
    .bind(format!("{account_id}@example.test"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, \
         created_at, last_seen_at) VALUES ($1, $2, 'Cache device', $3, $4, $4)",
    )
    .bind(&device_id)
    .bind(&account_id)
    .bind(format!("legacy:{suffix}"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    let session = crate::auth::session::issue_session(pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    (
        account_id,
        device_id,
        session.token_id,
        session.plaintext_token,
    )
}

fn manually_live() -> SessionLookupCache {
    let cache = SessionLookupCache::default();
    cache.set_listener_connected(true);
    cache.notification_received();
    cache
}

mod database_tests;
mod replica_tests;

mod metrics;
