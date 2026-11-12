//! The ticket route admits reconnects at a bounded rate and leaves every
//! other route alone.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use tower::ServiceExt;

use super::admission::tests::ManualClock;
use super::tests::{account_with_device, test_pool};
use crate::server::ServerState;

/// Synthetic cursor secret for this test process only.
const TEST_CURSOR_SECRET: &str = "realtime-admission-test-cursor-secret-0123456789";

fn request(method: &str, path: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn only_ticket_issuing_is_gated_and_it_refills_with_time() {
    let Some(pool) = test_pool().await else {
        return;
    };
    std::env::set_var("KORDI_CHAT_SYNC_CURSOR_SECRET", TEST_CURSOR_SECRET);
    let clock = ManualClock::new();
    let state = ServerState::new(pool.clone(), crate::events::EventBus::noop())
        .with_realtime_ticket_admission(clock.admission(1, 2));
    let router = crate::server::router(Arc::new(state));
    let (account_id, device_id) = account_with_device(&pool).await;
    let token = crate::auth::session::issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap()
        .plaintext_token;
    let ticket = || request("POST", "/v2/chat/realtime/ticket", &token);

    for _ in 0..2 {
        let response = router.clone().oneshot(ticket()).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
    }
    let refused = router.clone().oneshot(ticket()).await.unwrap();
    assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
    let wait: u64 = refused.headers()[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=10).contains(&wait), "{wait}");

    // Every other route keeps answering while tickets are refused.
    for _ in 0..5 {
        let bootstrap = router
            .clone()
            .oneshot(request("GET", "/v2/chat/sync/bootstrap", &token))
            .await
            .unwrap();
        assert_eq!(bootstrap.status(), StatusCode::OK);
    }
    assert_eq!(
        router.clone().oneshot(ticket()).await.unwrap().status(),
        StatusCode::TOO_MANY_REQUESTS
    );

    clock.advance(Duration::from_secs(1));
    assert_eq!(
        router.clone().oneshot(ticket()).await.unwrap().status(),
        StatusCode::CREATED,
        "a second later one more ticket is admitted"
    );
}
