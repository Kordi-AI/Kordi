//! The hashes of a deleted account's credentials
//! (`cloud_deleted_account_credentials`): what is listed, by both deletion
//! paths, that nothing identifying is kept, and the sweep. Also the pending
//! sign-up codes of the account's emails.

use super::*;
use crate::account_deletion::credentials::{sweep, was_deleted, CredentialKind};
use crate::account_deletion::operator::{dry_run, plan, run};
use crate::auth::session::{hash_session_token, issue_session, random_token_plaintext};

/// A device of `account_id` and a live 30-day session on it.
async fn signed_in(pool: &PgPool, account_id: &str) -> (String, String) {
    let device_id = format!("dev_deletion_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_devices \
         (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) \
         VALUES ($1, $2, 'Test device', $3, $4, $4)",
    )
    .bind(&device_id)
    .bind(account_id)
    .bind(format!("legacy:{device_id}"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    let session = issue_session(pool, account_id, &device_id, 30)
        .await
        .unwrap();
    (device_id, session.plaintext_token)
}

async fn listed(pool: &PgPool, token: &str) -> i64 {
    query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM cloud_deleted_account_credentials WHERE credential_hash = $1",
    )
    .bind(hash_session_token(token))
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}

#[tokio::test]
async fn the_table_keeps_hashes_kinds_and_expiries_only() {
    let Some(pool) = pool().await else { return };
    let (account_id, email) = person(&pool, "Quinn Sample").await;
    let (device_id, token) = signed_in(&pool, &account_id).await;
    let mut tx = pool.begin().await.unwrap();
    let deletion = delete_in_transaction(&mut tx, &account_id, DirectConversations::Empty)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(deletion.credentials.sessions, 1);
    assert!(was_deleted(&pool, CredentialKind::Session, &token).await);
    // The same plaintext as a refresh token is a different credential.
    assert!(!was_deleted(&pool, CredentialKind::Refresh, &token).await);

    let columns: Vec<(String,)> = query_as(
        "SELECT column_name::text FROM information_schema.columns \
         WHERE table_name = 'cloud_deleted_account_credentials' ORDER BY ordinal_position",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let columns: Vec<&str> = columns.iter().map(|(name,)| name.as_str()).collect();
    assert_eq!(columns, ["credential_hash", "kind", "expires_at"]);
    let (row,): (String,) = query_as(
        "SELECT row_to_json(c)::text FROM cloud_deleted_account_credentials c \
         WHERE credential_hash = $1",
    )
    .bind(hash_session_token(&token))
    .fetch_one(&pool)
    .await
    .unwrap();
    for identifying in [&account_id, &email, &device_id, &"Quinn Sample".to_string()] {
        assert!(!row.contains(identifying.as_str()), "{row}");
    }
    assert!(!row.contains(&token), "never the plaintext");
}

#[tokio::test]
async fn only_live_credentials_are_listed() {
    let Some(pool) = pool().await else { return };
    let (account_id, _) = person(&pool, "Riley Sample").await;
    let (device_id, live) = signed_in(&pool, &account_id).await;
    let signed_out = issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    crate::auth::session::revoke_session(&pool, &signed_out.token_id)
        .await
        .unwrap();
    let expired = issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    query("UPDATE cloud_refresh_tokens SET expires_at = $2 WHERE token_id = $1")
        .bind(&expired.token_id)
        .bind((Utc::now() - chrono::Duration::minutes(1)).to_rfc3339())
        .execute(&pool)
        .await
        .unwrap();
    let (_, on_revoked_device) = signed_in(&pool, &account_id).await;
    query(
        "UPDATE cloud_devices SET revoked_at = $2 WHERE device_id = \
         (SELECT device_id FROM cloud_refresh_tokens WHERE token_hash = $1)",
    )
    .bind(hash_session_token(&on_revoked_device))
    .bind(Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();

    delete(&pool, &account_id, DirectConversations::Empty).await;
    assert_eq!(listed(&pool, &live).await, 1);
    for token in [
        &signed_out.plaintext_token,
        &expired.plaintext_token,
        &on_revoked_device,
    ] {
        assert_eq!(listed(&pool, token).await, 0, "a signed-out credential");
        assert!(!was_deleted(&pool, CredentialKind::Session, token).await);
    }
}

#[tokio::test]
async fn expired_hashes_are_swept_and_no_longer_match() {
    let Some(pool) = pool().await else { return };
    let expired = random_token_plaintext();
    let current = random_token_plaintext();
    for (token, offset) in [(&expired, "-1 minute"), (&current, "1 day")] {
        query(
            "INSERT INTO cloud_deleted_account_credentials (credential_hash, kind, expires_at) \
             VALUES ($1, 'session', now() + $2::interval)",
        )
        .bind(hash_session_token(token))
        .bind(offset)
        .execute(&pool)
        .await
        .unwrap();
    }
    // An expired hash no longer answers, even before the sweep runs.
    assert!(!was_deleted(&pool, CredentialKind::Session, &expired).await);
    assert!(was_deleted(&pool, CredentialKind::Session, &current).await);
    assert!(sweep(&pool).await.unwrap() >= 1);
    assert_eq!(listed(&pool, &expired).await, 0);
    assert_eq!(listed(&pool, &current).await, 1);
}

#[tokio::test]
async fn the_operator_command_lists_credentials_too_but_a_dry_run_does_not() {
    let Some(pool) = pool().await else { return };
    let (gone, gone_email) = person(&pool, "Sage Sample").await;
    let (_, token) = signed_in(&pool, &gone).await;
    let targets = plan(&pool, std::slice::from_ref(&gone_email), &[])
        .await
        .unwrap()
        .expect("a valid plan");

    let outcomes = dry_run(&pool, &targets).await;
    let deletion = outcomes[0].result.as_ref().expect("the dry run succeeds");
    assert_eq!(deletion.credentials.sessions, 1, "measured");
    assert_eq!(listed(&pool, &token).await, 0, "and rolled back");

    let state = crate::server::ServerState::new(pool.clone(), crate::events::EventBus::noop());
    let outcomes = run(&state, &targets).await;
    assert!(outcomes[0].result.is_ok(), "{}", outcomes[0].line());
    assert!(!account_exists(&pool, &gone).await);
    assert!(was_deleted(&pool, CredentialKind::Session, &token).await);
}

#[tokio::test]
async fn pending_sign_up_codes_of_the_accounts_emails_are_deleted() {
    let Some(pool) = pool().await else { return };
    let (account_id, email) = person(&pool, "Tatum Sample").await;
    let linked = format!("linked-{}@example.test", Uuid::new_v4().simple());
    let unrelated = format!("unrelated-{}@example.test", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_account_identities \
         (identity_id, account_id, provider, provider_subject, email, email_verified, \
          created_at, updated_at) \
         VALUES ($1, $2, 'google', $3, $4, TRUE, $5, $5)",
    )
    .bind(format!("ident_{}", Uuid::new_v4().simple()))
    .bind(&account_id)
    .bind(format!("subject-{}", Uuid::new_v4().simple()))
    .bind(&linked)
    .bind(Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();
    // The primary email in another case, a linked sign-in email, and an
    // address of nobody in particular.
    for address in [email.to_uppercase(), linked.clone(), unrelated.clone()] {
        query(
            "INSERT INTO cloud_signup_email_codes \
             (email, verification_id, code_mac, expires_at, resend_after, window_started_at, \
              send_count, attempts_remaining) \
             VALUES ($1, $2, '\\x00', now() + interval '10 minutes', now() + interval '1 minute', \
                     now(), 1, 5)",
        )
        .bind(address)
        .bind(format!("verify_{}", Uuid::new_v4().simple()))
        .execute(&pool)
        .await
        .unwrap();
    }

    delete(&pool, &account_id, DirectConversations::Empty).await;
    let remaining: Vec<(String,)> = query_as(
        "SELECT email FROM cloud_signup_email_codes WHERE lower(email) = ANY($1) ORDER BY email",
    )
    .bind(vec![
        email.to_lowercase(),
        linked.to_lowercase(),
        unrelated.clone(),
    ])
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(remaining, vec![(unrelated,)]);
}

#[tokio::test]
async fn ticket_routes_answer_account_deleted_before_a_socket_opens() {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    use crate::auth::routes::{web_csrf_token, WEB_CSRF_HEADER, WEB_SESSION_COOKIE};

    let Some(pool) = pool().await else { return };
    let (account_id, _) = person(&pool, "Uma Sample").await;
    let (_, token) = signed_in(&pool, &account_id).await;
    delete(&pool, &account_id, DirectConversations::Empty).await;
    let state = crate::server::ServerState::new(pool.clone(), crate::events::EventBus::noop());
    let router = crate::server::router(std::sync::Arc::new(state));
    let bearer = |uri: &str| {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("Authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    let cookie = |uri: &str| {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("Cookie", format!("{WEB_SESSION_COOKIE}={token}"))
            .header("Origin", crate::distribution::public_origin())
            .header(WEB_CSRF_HEADER, web_csrf_token(&token))
            .body(Body::empty())
            .unwrap()
    };
    for request in [
        bearer("/v2/chat/realtime/ticket"),
        cookie("/v2/chat/realtime/ticket"),
        bearer("/v1/cloud/documents/att_missing/collab/ticket"),
    ] {
        let uri = request.uri().to_string();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{uri}");
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 16)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["errorCode"], "account_deleted", "{uri}: {body}");
    }
}
