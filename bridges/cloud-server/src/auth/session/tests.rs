//! Session lifecycle checks against a real Postgres at `$DATABASE_URL`.
//! Skipped when `DATABASE_URL` is unset.

use super::*;

async fn pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    Some(crate::pg::init_pool(&url).await.expect("init test pool"))
}

async fn account_with_device(pool: &PgPool) -> (String, String) {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let account_id = format!("acct_session_{suffix}");
    let device_id = format!("dev_session_{suffix}");
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, avatar_source, \
          avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, 'Session', $2, $3, $3, 'generated', 'lorelei', $1, 'fixture', 1, $3)",
    )
    .bind(&account_id)
    .bind(format!("{account_id}@example.test"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) \
         VALUES ($1, $2, 'Session device', $3, $4, $4)",
    )
    .bind(&device_id)
    .bind(&account_id)
    .bind(format!("legacy:{suffix}"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    (account_id, device_id)
}

#[tokio::test]
async fn signed_out_sessions_stop_long_lived_connections() {
    let Some(pool) = pool().await else { return };
    let (account_id, device_id) = account_with_device(&pool).await;
    let kept = issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    let signed_out = issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();

    assert!(
        session_is_active(&pool, &account_id, &device_id, &signed_out.token_id)
            .await
            .unwrap()
    );
    revoke_session(&pool, &signed_out.token_id).await.unwrap();

    assert!(
        !session_is_active(&pool, &account_id, &device_id, &signed_out.token_id)
            .await
            .unwrap(),
        "a signed-out session must not keep a connection open"
    );
    assert!(
        device_is_active(&pool, &account_id, &device_id)
            .await
            .unwrap(),
        "signing out one session leaves the device authorized"
    );
    assert!(
        session_is_active(&pool, &account_id, &device_id, &kept.token_id)
            .await
            .unwrap(),
        "other sessions on the device are unaffected"
    );
    assert!(
        !session_is_active(&pool, "acct_other", &device_id, &kept.token_id)
            .await
            .unwrap(),
        "a session is bound to its own account"
    );
}

#[tokio::test]
async fn expired_sessions_and_revoked_devices_stop_long_lived_connections() {
    let Some(pool) = pool().await else { return };
    let (account_id, device_id) = account_with_device(&pool).await;
    let session = issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();

    query("UPDATE cloud_refresh_tokens SET expires_at = $1 WHERE token_id = $2")
        .bind((Utc::now() - Duration::minutes(1)).to_rfc3339())
        .bind(&session.token_id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        !session_is_active(&pool, &account_id, &device_id, &session.token_id)
            .await
            .unwrap()
    );

    let fresh = issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    query("UPDATE cloud_devices SET revoked_at = $1 WHERE device_id = $2")
        .bind(Utc::now().to_rfc3339())
        .bind(&device_id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        !session_is_active(&pool, &account_id, &device_id, &fresh.token_id)
            .await
            .unwrap()
    );
}

async fn stored_expiry(pool: &PgPool, token_id: &str) -> DateTime<Utc> {
    let (expires_at,): (String,) =
        query_as("SELECT expires_at FROM cloud_refresh_tokens WHERE token_id = $1")
            .bind(token_id)
            .fetch_one(pool)
            .await
            .unwrap();
    DateTime::parse_from_rfc3339(&expires_at)
        .unwrap()
        .with_timezone(&Utc)
}

async fn set_expiry(pool: &PgPool, token_id: &str, expires_at: DateTime<Utc>) {
    query("UPDATE cloud_refresh_tokens SET expires_at = $1 WHERE token_id = $2")
        .bind(expires_at.to_rfc3339())
        .bind(token_id)
        .execute(pool)
        .await
        .unwrap();
}

async fn looked_up(pool: &PgPool, plaintext: &str) -> CloudSessionRow {
    lookup_session(pool, plaintext)
        .await
        .unwrap()
        .expect("live session")
}

#[test]
fn sliding_expiry_target_skips_bumps_inside_the_granularity() {
    let now = Utc::now();
    let target = now + Duration::days(30);
    assert_eq!(sliding_expiry_target(target, now, 30), None);
    assert_eq!(
        sliding_expiry_target(target - Duration::minutes(59), now, 30),
        None,
        "an expiry within the granularity of the target is left alone"
    );
    assert_eq!(
        sliding_expiry_target(target - Duration::minutes(61), now, 30),
        Some(target)
    );
    assert_eq!(
        sliding_expiry_target(now + Duration::days(1), now, 30),
        Some(target)
    );
    assert_eq!(
        sliding_expiry_target(now - Duration::days(1), now, 30),
        Some(target),
        "a stale or unparsable expiry always slides"
    );
}

#[tokio::test]
async fn sliding_expiry_is_written_at_most_once_per_granularity() {
    let Some(pool) = pool().await else { return };
    let (account_id, device_id) = account_with_device(&pool).await;
    let session = issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();

    // A freshly issued session is already at the target: no write.
    let row = looked_up(&pool, &session.plaintext_token).await;
    assert!(row.sliding_expiry);
    assert!(!bump_expiry(&pool, &row, 30).await.unwrap());

    // An expiry that trails the target by more than the granularity slides.
    let stale = Utc::now() + Duration::days(29);
    set_expiry(&pool, &session.token_id, stale).await;
    let row = looked_up(&pool, &session.plaintext_token).await;
    let before = Utc::now();
    assert!(bump_expiry(&pool, &row, 30).await.unwrap());
    let bumped = stored_expiry(&pool, &session.token_id).await;
    assert!(bumped >= before + Duration::days(30) - Duration::seconds(1));

    // The next request inside the window sends no update.
    let row = looked_up(&pool, &session.plaintext_token).await;
    assert!(!bump_expiry(&pool, &row, 30).await.unwrap());
    assert_eq!(stored_expiry(&pool, &session.token_id).await, bumped);

    // A concurrent request that loaded the stale row updates nothing.
    let mut racing = row.clone();
    racing.expires_at = stale;
    assert!(!bump_expiry(&pool, &racing, 30).await.unwrap());
    assert_eq!(stored_expiry(&pool, &session.token_id).await, bumped);

    // Once the window has passed, the expiry slides again.
    let aged = Utc::now() + Duration::days(30) - Duration::minutes(90);
    set_expiry(&pool, &session.token_id, aged).await;
    let row = looked_up(&pool, &session.plaintext_token).await;
    assert!(bump_expiry(&pool, &row, 30).await.unwrap());
    assert!(stored_expiry(&pool, &session.token_id).await > aged + Duration::minutes(60));
}

#[tokio::test]
async fn sliding_expiry_leaves_revoked_and_fixed_sessions_untouched() {
    let Some(pool) = pool().await else { return };
    let (account_id, device_id) = account_with_device(&pool).await;
    let stale = Utc::now() + Duration::days(2);

    let signed_out = issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    let mut row = looked_up(&pool, &signed_out.plaintext_token).await;
    row.expires_at = stale;
    set_expiry(&pool, &signed_out.token_id, stale).await;
    revoke_session(&pool, &signed_out.token_id).await.unwrap();
    assert!(!bump_expiry(&pool, &row, 30).await.unwrap());
    assert_eq!(stored_expiry(&pool, &signed_out.token_id).await, stale);

    // A browser sign-in access token keeps its fixed expiry, both when the
    // lookup flags it and when a caller passes a row that claims otherwise.
    let sign_in_id = format!("asi_{}", uuid::Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_app_sign_ins \
         (sign_in_id, account_id, device_id, client_id, created_at, last_refreshed_at) \
         VALUES ($1, $2, $3, 'test-client', now(), now())",
    )
    .bind(&sign_in_id)
    .bind(&account_id)
    .bind(&device_id)
    .execute(&pool)
    .await
    .unwrap();
    let access = issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    query("UPDATE cloud_refresh_tokens SET app_sign_in_id = $1 WHERE token_id = $2")
        .bind(&sign_in_id)
        .bind(&access.token_id)
        .execute(&pool)
        .await
        .unwrap();
    set_expiry(&pool, &access.token_id, stale).await;
    let row = looked_up(&pool, &access.plaintext_token).await;
    assert!(!row.sliding_expiry);
    assert!(!bump_expiry(&pool, &row, 30).await.unwrap());
    let mut forced = row.clone();
    forced.sliding_expiry = true;
    assert!(!bump_expiry(&pool, &forced, 30).await.unwrap());
    assert_eq!(stored_expiry(&pool, &access.token_id).await, stale);

    // A revoked device stops every session on it from sliding.
    let on_device = issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    set_expiry(&pool, &on_device.token_id, stale).await;
    let row = looked_up(&pool, &on_device.plaintext_token).await;
    query("UPDATE cloud_devices SET revoked_at = $1 WHERE device_id = $2")
        .bind(Utc::now().to_rfc3339())
        .bind(&device_id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(!bump_expiry(&pool, &row, 30).await.unwrap());
    assert_eq!(stored_expiry(&pool, &on_device.token_id).await, stale);
}

mod activity;
