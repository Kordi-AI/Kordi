//! The readers route end to end: signed-in accounts, the real router, and the
//! JSON the apps decode.

use std::sync::Arc;
use std::time::Duration;

use super::*;
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use kordi_cloud_server::auth::rate_limit::{
    BudgetOverrides, CloudRateLimitConfig, CloudRateLimiter,
};
use kordi_cloud_server::server::router_with_rate_limiter;
use serde_json::Value;
use tower::util::ServiceExt;

#[path = "../common/signup_email.rs"]
mod signup_email_fixture;

fn router(pool: &PgPool) -> axum::Router {
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig {
        per_email_failure_limit: 5,
        per_email_lockout: Duration::from_secs(900),
        per_email_global_failure_limit: 50,
    })
    .with_budget_overrides(BudgetOverrides::unauthenticated(
        10_000,
        Duration::from_secs(60),
    ));
    router_with_rate_limiter(Arc::new(signup_email_fixture::state(pool.clone())), limiter)
}

async fn call(
    router: &axum::Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let body = if body.is_null() {
        Body::empty()
    } else {
        Body::from(body.to_string())
    };
    let response = router
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// Signs up a synthetic account and returns (account id, session token).
async fn sign_up(router: &axum::Router, label: &str) -> (String, String) {
    let body = signup_email_fixture::with_proof(json!({
        "email": format!("readers-{label}-{}@example.test", Uuid::new_v4().simple()),
        "password": "Correct-horse-7",
        "displayName": label,
        "avatarSeed": "readers_avatar",
    }))
    .await;
    let (status, body) = call(router, "POST", "/v1/cloud/auth/signup", None, body).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    (
        body["account"]["accountId"].as_str().unwrap().to_string(),
        body["session"]["token"].as_str().unwrap().to_string(),
    )
}

#[tokio::test]
async fn the_readers_route_answers_the_author_and_refuses_large_groups() {
    let Some(pool) = try_pool().await else { return };
    let router = router(&pool);
    let (author, author_token) = sign_up(&router, "author").await;
    let (reader, reader_token) = sign_up(&router, "reader").await;
    connect_accounts(&pool, &author, &reader).await;
    let group = store::create_conversation(
        &pool,
        &author,
        super::super::group_request(vec![reader.clone()], None),
    )
    .await
    .unwrap()
    .value
    .id;
    let message = store::send_message(
        &pool,
        &author,
        group,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".to_string(),
            content: content("Synthetic route check"),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .unwrap()
    .value;
    read(&pool, &reader, group, message.conversation_sequence).await;
    let uri = format!(
        "/v2/chat/conversations/{group}/messages/{}/readers?limit=4",
        message.id
    );

    let (status, body) = call(&router, "GET", &uri, Some(&author_token), Value::Null).await;
    eprintln!("readers route 200: {body}");
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["total"], 1);
    assert_eq!(body["readers"][0]["account_id"], json!(reader));
    let read_at = body["readers"][0]["read_at"].as_str().expect("read time");
    assert!(chrono::DateTime::parse_from_rfc3339(read_at).is_ok());
    assert_eq!(body["readers"][0].as_object().unwrap().len(), 2);

    let (status, body) = call(&router, "GET", &uri, Some(&reader_token), Value::Null).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    super::add_people(&pool, group, 100).await;
    let (status, body) = call(&router, "GET", &uri, Some(&author_token), Value::Null).await;
    eprintln!("readers route 409: {body}");
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "readers_unavailable");
}
