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
        row: CloudSessionRow {
            token_id: token_id.to_string(),
            account_id: account_id.to_string(),
            device_id: format!("dev_{account_id}"),
            expires_at: Utc::now() + expires_in,
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
