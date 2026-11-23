//! A deleted account's credentials are answered with `account_deleted`
//! (docs/development/account-deletion.md, "For clients"): a bearer token, a
//! browser sign-in's access and refresh tokens, and the web session cookie.
//! A token that was signed out before the deletion keeps its old answer.

use super::*;
use crate::account_deletion::credentials::ACCOUNT_DELETED;
use crate::auth::routes::web_session_handlers::{WEB_CSRF_COOKIE, WEB_SESSION_COOKIE};
use crate::auth::session::{hash_session_token, issue_session, revoke_session};

const DELETE: &str = "/v1/cloud/account/security/delete";

async fn device_of(harness: &Harness, account_id: &str) -> String {
    let (device_id,): (String,) =
        query_as("SELECT device_id FROM cloud_devices WHERE account_id = $1 LIMIT 1")
            .bind(account_id)
            .fetch_one(&harness.pool)
            .await
            .unwrap();
    device_id
}

/// `GET /v1/cloud/auth/me` with a bearer token: (status, body).
async fn me(harness: &Harness, token: &str) -> (StatusCode, Value) {
    let (status, body, _) = harness
        .send("GET", "/v1/cloud/auth/me", Some(token), None)
        .await;
    (status, body)
}

fn set_cookies(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all("set-cookie")
        .iter()
        .map(|value| value.to_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn a_deleted_accounts_credentials_answer_account_deleted() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let device_id = device_of(&harness, &account.account_id).await;
    let app = harness.signed_in(&account, DESKTOP, LOOPBACK).await;
    let access_token = token(&app, "access_token");
    let refresh_token = token(&app, "refresh_token");
    let bearer = issue_session(&harness.pool, &account.account_id, &device_id, 30)
        .await
        .unwrap();
    let signed_out = issue_session(&harness.pool, &account.account_id, &device_id, 30)
        .await
        .unwrap();
    revoke_session(&harness.pool, &signed_out.token_id)
        .await
        .unwrap();
    assert_eq!(
        me(&harness, &bearer.plaintext_token).await.0,
        StatusCode::OK
    );

    // The web page deletes the account with its cookie, right after signing
    // in, so no other proof is needed.
    let (status, body, headers) = harness
        .send_with(
            "POST",
            DELETE,
            web_headers(&account.web_token),
            Some(("application/json", "{}".to_string())),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    // The 204 clears the page's cookies.
    let cookies = set_cookies(&headers);
    for name in [WEB_SESSION_COOKIE, WEB_CSRF_COOKIE] {
        assert!(
            cookies
                .iter()
                .any(|cookie| cookie.starts_with(&format!("{name}=;"))
                    && cookie.contains("Max-Age=0")),
            "{name} is cleared: {cookies:?}"
        );
    }

    // A bearer token and a browser sign-in's access token.
    for token in [&bearer.plaintext_token, &access_token] {
        let (status, body) = me(&harness, token).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body["errorCode"], ACCOUNT_DELETED, "{body}");
        assert_eq!(body["message"], "This account was deleted.");
    }
    // The web session cookie, on a page read and on the session check.
    for uri in ["/v1/cloud/auth/web/session", "/v1/cloud/account/security"] {
        let (status, body, _) = harness
            .send_with("GET", uri, web_headers(&account.web_token), None)
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}: {body}");
        assert_eq!(body["errorCode"], ACCOUNT_DELETED, "{uri}: {body}");
    }
    // The refresh token: still an OAuth `invalid_grant`, with the reason.
    let (status, body) = harness.refresh(DESKTOP, &refresh_token).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], "invalid_grant");
    assert_eq!(body["errorCode"], ACCOUNT_DELETED);
    assert_eq!(body["error_description"], "This account was deleted.");
    // A token signed out before the deletion keeps its old answer, and so
    // does one that never existed.
    let never = crate::auth::session::random_token_plaintext();
    for token in [&signed_out.plaintext_token, &never] {
        let (status, body) = me(&harness, token).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["errorCode"], "invalid_session", "{body}");
    }
    let (status, body) = harness
        .refresh(DESKTOP, &format!("{}x", refresh_token))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["errorCode"], "invalid_grant", "{body}");

    // Only hashes are kept, each until its credential would have expired.
    type Row = (String, String, bool, bool);
    let rows: Vec<Row> = query_as(
        "SELECT credential_hash, kind, expires_at <= now() + interval '30 days 1 minute', \
                expires_at <= now() + interval '2 hours' \
         FROM cloud_deleted_account_credentials \
         WHERE credential_hash = ANY($1) ORDER BY kind, credential_hash",
    )
    .bind(vec![
        hash_session_token(&bearer.plaintext_token),
        hash_session_token(&access_token),
        hash_session_token(&account.web_token),
        hash_session_token(&refresh_token),
        hash_session_token(&signed_out.plaintext_token),
    ])
    .fetch_all(&harness.pool)
    .await
    .unwrap();
    let kinds: Vec<&str> = rows.iter().map(|row| row.1.as_str()).collect();
    assert_eq!(
        kinds,
        ["refresh", "session", "session", "session"],
        "the signed-out token is not listed"
    );
    assert!(rows.iter().all(|row| row.2), "capped at 30 days");
    let access_row = rows
        .iter()
        .find(|row| row.0 == hash_session_token(&access_token))
        .unwrap();
    assert!(
        access_row.3,
        "the one-hour access token expires with itself"
    );
    let bearer_row = rows
        .iter()
        .find(|row| row.0 == hash_session_token(&bearer.plaintext_token))
        .unwrap();
    assert!(!bearer_row.3, "a 30-day session keeps its own expiry");
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn an_app_deleting_its_account_gets_no_cookie_and_its_token_answers_account_deleted() {
    let harness = harness().await;
    let account = harness.web_account().await;
    let device_id = device_of(&harness, &account.account_id).await;
    let bearer = issue_session(&harness.pool, &account.account_id, &device_id, 30)
        .await
        .unwrap();
    let (status, body, headers) = harness
        .send_with(
            "POST",
            DELETE,
            vec![(
                "Authorization".to_string(),
                format!("Bearer {}", bearer.plaintext_token),
            )],
            Some(("application/json", "{}".to_string())),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    assert!(
        set_cookies(&headers).is_empty(),
        "a bearer caller has no cookie"
    );
    let (status, body) = me(&harness, &bearer.plaintext_token).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["errorCode"], ACCOUNT_DELETED, "{body}");
}
