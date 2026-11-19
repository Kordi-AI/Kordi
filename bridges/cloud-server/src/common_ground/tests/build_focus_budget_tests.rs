//! A profile's focus line is evidence for its card build, and build starts
//! are budgeted per profile under an account-wide ceiling.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{HeaderMap, Request};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx_core::query_scalar::query_scalar;
use sqlx_postgres::PgPool;
use tower::ServiceExt;

use super::db_fixture::{account, app, pool, send, signed_in};
use super::profile_support::{create_profile, PROFILES};
use crate::auth::rate_limit::{BudgetOverrides, CloudRateLimitConfig, CloudRateLimiter};
use crate::common_ground::build::focus_item;
use crate::common_ground::profiles::MAX_PROFILES;
use crate::common_ground::{BUILD_ACCOUNT_LIMIT, BUILD_LIMIT};

const BUILD: &str = "/v1/cloud/common-ground/card/build";

#[test]
fn the_focus_line_is_the_owners_words_redacted() {
    assert_eq!(focus_item(None), None);
    assert_eq!(focus_item(Some("")), None);
    assert_eq!(focus_item(Some(" \n\t ")), None);

    let item = focus_item(Some(
        "  Agent memory   research; write to ada@example.test ",
    ))
    .expect("a focus is evidence");
    assert_eq!(item.source, "Your words");
    assert_eq!(item.title, "Profile focus");
    assert_eq!(item.url, None);
    assert_eq!(item.text, "Agent memory research; write to [email]");
    assert!(!item.text.contains("ada@example.test"), "{item:?}");
    let date = item.date.as_deref().expect("dated today");
    assert!(chrono::DateTime::parse_from_rfc3339(date).is_ok(), "{date}");
}

#[test]
fn the_account_ceiling_holds_every_profiles_full_budget() {
    assert_eq!(
        i64::from(BUILD_ACCOUNT_LIMIT.limit),
        i64::from(BUILD_LIMIT.limit) * MAX_PROFILES
    );
    assert_eq!(BUILD_ACCOUNT_LIMIT.window, BUILD_LIMIT.window);
    assert_ne!(BUILD_ACCOUNT_LIMIT.action, BUILD_LIMIT.action);
}

/// Creates a custom profile with `focus` and returns its id.
async fn profile_with_focus(app: &Router, token: &str, name: &str, focus: &str) -> String {
    let (status, body) = send(
        app,
        "POST",
        PROFILES,
        token,
        Some(json!({"kind": "custom", "name": name, "focus": focus})),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    body["profileId"].as_str().unwrap().to_string()
}

/// The prompt of the run queued for `profile_id`'s card.
async fn queued_prompt(pool: &PgPool, profile_id: &str) -> String {
    query_scalar(
        "SELECT run.prompt FROM cloud_agent_fallback_runs run
         JOIN cloud_common_ground_cards card ON card.active_run_id = run.run_id
         WHERE card.profile_id = $1",
    )
    .bind(profile_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Starts a build and returns the status, the `Retry-After` header and the
/// body.
async fn start(app: &Router, token: &str, body: Value) -> (u16, HeaderMap, Value) {
    let request = Request::builder()
        .method("POST")
        .uri(BUILD)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, headers, value)
}

#[tokio::test]
async fn a_profile_with_a_focus_builds_without_another_source() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (_, token) = signed_in(&pool, "Alex").await;
    let focus = "Retrieval for long-running coding agents";
    let kaust = profile_with_focus(&app, &token, "KAUST", focus).await;
    let work = create_profile(&app, &token, "work", None).await;

    // Nothing but the focus: the build starts, and the focus is evidence.
    let (status, body) = send(
        &app,
        "POST",
        BUILD,
        &token,
        Some(json!({"profileId": kaust})),
    )
    .await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["build"]["status"], "building", "{body}");
    assert_eq!(body["used"], json!([]), "the focus is not a picked source");
    let prompt = queued_prompt(&pool, &kaust).await;
    assert!(
        prompt.contains(&format!("· Your words · Profile focus\n{focus}\n")),
        "{prompt}"
    );

    // A profile without a focus still needs a source.
    let (status, body) = send(
        &app,
        "POST",
        BUILD,
        &token,
        Some(json!({"profileId": work})),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (400, Some("common_ground_no_sources")),
        "{body}"
    );

    // A link that cannot be read no longer leaves the build with nothing.
    let daily = profile_with_focus(&app, &token, "Weekends", "Bouldering and sourdough").await;
    // `.test` never resolves, so the page cannot be fetched.
    let url = "https://climbing.example.test/me";
    let request = json!({"profileId": daily, "links": url});
    let (status, body) = send(&app, "POST", BUILD, &token, Some(request)).await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(
        body["build"]["unreadLinks"],
        json!([{"url": url, "reason": "unreachable"}]),
        "{body}"
    );
    let prompt = queued_prompt(&pool, &daily).await;
    let header = |index: usize, rest: &str| {
        prompt
            .lines()
            .any(|line| line.starts_with(&format!("[{index}] ")) && line.ends_with(rest))
    };
    assert!(header(0, &format!("· Link · {url}")), "{prompt}");
    assert!(
        prompt.contains("(This page could not be read.)"),
        "{prompt}"
    );
    assert!(
        header(1, "· Your words · Profile focus"),
        "the focus comes after the link: {prompt}"
    );
    assert!(
        prompt.contains("Profile focus\nBouldering and sourdough\n"),
        "{prompt}"
    );
}

#[tokio::test]
async fn each_profile_has_its_own_build_budget() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (_, token) = signed_in(&pool, "Alex").await;
    let first = create_profile(&app, &token, "work", None).await;
    let second = create_profile(&app, &token, "health", None).await;
    let notes = |profile: &str| json!({"profileId": profile, "notes": "I study agent memory."});

    // Starts refused because a build is in flight still count.
    for attempt in 0..BUILD_LIMIT.limit {
        let (status, _, body) = start(&app, &token, notes(first.as_str())).await;
        let expected = if attempt == 0 { 202 } else { 409 };
        assert_eq!(status, expected, "attempt {attempt}: {body}");
    }
    let (status, headers, body) = start(&app, &token, notes(first.as_str())).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (429, Some("rate_limited")),
        "{body}"
    );
    let retry_after: u64 = headers
        .get("Retry-After")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .expect("a Retry-After header");
    assert!((1..=3600).contains(&retry_after), "{retry_after}");

    // The account's other profile still builds.
    let (status, _, body) = start(&app, &token, notes(second.as_str())).await;
    assert_eq!(status, 202, "{body}");
}

#[tokio::test]
async fn the_account_ceiling_refuses_once_spent() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let state = crate::server::ServerState::new(pool.clone(), crate::events::EventBus::noop())
        .with_system_agent(crate::system_agent::SystemAgentService::new(
            crate::system_agent::test_config(&service),
        ));
    let overrides = format!("{}=2/1h", BUILD_ACCOUNT_LIMIT.action);
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig::production())
        .with_budget_overrides(BudgetOverrides::parse(&overrides).unwrap());
    let app = crate::server::router_with_rate_limiter(Arc::new(state), limiter);
    let (_, token) = signed_in(&pool, "Alex").await;
    let mut profiles = Vec::new();
    for kind in ["work", "health", "daily"] {
        profiles.push(create_profile(&app, &token, kind, None).await);
    }
    let notes = |profile: &str| json!({"profileId": profile, "notes": "I study agent memory."});

    for profile in &profiles[..2] {
        let (status, _, body) = start(&app, &token, notes(profile.as_str())).await;
        assert_eq!(status, 202, "{body}");
    }
    // The third profile's own budget is untouched, but the account's is spent.
    let (status, headers, body) = start(&app, &token, notes(profiles[2].as_str())).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (429, Some("rate_limited")),
        "{body}"
    );
    assert!(headers.contains_key("Retry-After"), "{headers:?}");
}
