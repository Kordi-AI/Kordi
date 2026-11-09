//! Reconnecting a saved hosted sign-in renews it: the finished login keeps the
//! account's choice and label and replaces its snapshot instead of adding a
//! second account. Every credential below is synthetic.

use kordi_cloud_server::cloud_agent_runtime::provider_auth::{
    EnvProviderAuthCipher, ProviderAuthCipher,
};

use super::login_session::{
    cloud_login_snapshots, login_request, login_router, session_status, start_login,
};
use super::omp_worker::mock_worker;
use super::*;

/// Enters `key` on a started Anthropic key login and returns the final state.
async fn finish_key_login(
    router: &axum::Router,
    token: &str,
    session_id: &str,
    key: &str,
) -> (StatusCode, Value) {
    let (status, _) = login_request(
        router,
        token,
        "POST",
        &format!("/{session_id}/input"),
        Some(json!({ "value": key })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    login_request(router, token, "GET", &format!("/{session_id}"), None).await
}

async fn live_payload(pool: &sqlx_postgres::PgPool, account_id: &str, choice: &str) -> Value {
    let (encrypted,): (Vec<u8>,) = sqlx_core::query_as::query_as(
        "SELECT encrypted_payload FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND auth_choice = $2 AND revoked_at IS NULL",
    )
    .bind(account_id)
    .bind(choice)
    .fetch_one(pool)
    .await
    .unwrap();
    serde_json::from_slice(
        &EnvProviderAuthCipher::from_env()
            .unwrap()
            .decrypt(&encrypted)
            .unwrap(),
    )
    .unwrap()
}

fn renew_body(provider: &str, choice: &str) -> Value {
    json!({
        "provider": provider,
        "label": "Personal",
        "method": "api-key",
        "renewAuthChoice": choice,
    })
}

#[tokio::test]
async fn reconnecting_a_hosted_sign_in_keeps_its_choice_and_label() {
    let Some(pool) = try_pool().await else { return };
    let (_worker, _worker_env) = mock_worker().await;
    let router = login_router(&pool);
    let owner = signup(&router, "provider-login-renew-owner", "Owner").await;
    let intruder = signup(&router, "provider-login-renew-intruder", "Intruder").await;

    let first = start_login(
        &router,
        &owner.token,
        json!({ "provider": "anthropic", "label": "Work", "method": "api-key" }),
    )
    .await;
    let (status, saved) =
        finish_key_login(&router, &owner.token, &first, "synthetic-first-key").await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let choice = format!("cloud-login:{first}");
    assert_eq!(saved["snapshot"]["authChoice"], choice.as_str());
    let first_snapshot = saved["snapshot"]["snapshotId"]
        .as_str()
        .unwrap()
        .to_string();

    // Another account, another provider family, an unknown sign-in, or a
    // choice no hosted login made cannot be renewed.
    for (token, body, expected) in [
        (
            &intruder.token,
            renew_body("anthropic", &choice),
            StatusCode::CONFLICT,
        ),
        (
            &owner.token,
            renew_body("groq", &choice),
            StatusCode::CONFLICT,
        ),
        (
            &owner.token,
            renew_body(
                "anthropic",
                "cloud-login:00000000-0000-4000-8000-0000000000aa",
            ),
            StatusCode::CONFLICT,
        ),
        (
            &owner.token,
            renew_body("anthropic", "profile:work"),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let (status, rejected) = login_request(&router, token, "POST", "/start", Some(body)).await;
        assert_eq!(status, expected, "{rejected}");
        let code = if expected == StatusCode::CONFLICT {
            "login_account_not_found"
        } else {
            "invalid_login_input"
        };
        assert_eq!(rejected["errorCode"], code);
    }

    // The client's suggested name is ignored: a renewal keeps the saved one.
    let renewal = start_login(&router, &owner.token, renew_body("anthropic", &choice)).await;
    let (label, renews): (String, Option<String>) = sqlx_core::query_as::query_as(
        "SELECT label, renews_auth_choice FROM cloud_agent_provider_login_sessions \
         WHERE session_id = $1",
    )
    .bind(&renewal)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (label.as_str(), renews.as_deref()),
        ("Work", Some(choice.as_str()))
    );
    let (status, renewed) =
        finish_key_login(&router, &owner.token, &renewal, "synthetic-renewed-key").await;
    assert_eq!(status, StatusCode::OK, "{renewed}");
    assert_eq!(renewed["status"], "completed");
    assert_eq!(renewed["snapshot"]["authChoice"], choice.as_str());
    assert_eq!(renewed["snapshot"]["label"], "Work");
    assert_ne!(renewed["snapshot"]["snapshotId"], first_snapshot.as_str());

    // One live account under the original choice, now holding the new key.
    let work = || {
        (
            "anthropic".to_string(),
            choice.clone(),
            Some("Work".to_string()),
        )
    };
    let snapshots = cloud_login_snapshots(&pool, &owner.account_id).await;
    assert_eq!(
        snapshots,
        vec![
            (work().0, work().1, work().2, false),
            (work().0, work().1, work().2, true),
        ]
    );
    let payload = live_payload(&pool, &owner.account_id, &choice).await;
    assert_eq!(payload["apiKey"], "synthetic-renewed-key");
    assert!(cloud_login_snapshots(&pool, &intruder.account_id)
        .await
        .is_empty());
}

#[tokio::test]
async fn a_sign_in_removed_during_its_renewal_stays_removed() {
    let Some(pool) = try_pool().await else { return };
    let (_worker, _worker_env) = mock_worker().await;
    let router = login_router(&pool);
    let owner = signup(&router, "provider-login-renew-removed", "Owner").await;

    let first = start_login(
        &router,
        &owner.token,
        json!({ "provider": "anthropic", "label": "Work", "method": "api-key" }),
    )
    .await;
    let (status, _) = finish_key_login(&router, &owner.token, &first, "synthetic-first-key").await;
    assert_eq!(status, StatusCode::OK);
    let choice = format!("cloud-login:{first}");

    let renewal = start_login(&router, &owner.token, renew_body("anthropic", &choice)).await;
    sqlx_core::query::query(
        "UPDATE cloud_agent_provider_auth_snapshots SET revoked_at = now()::TEXT \
         WHERE account_id = $1 AND auth_choice = $2",
    )
    .bind(&owner.account_id)
    .bind(&choice)
    .execute(&pool)
    .await
    .unwrap();
    let (status, failed) =
        finish_key_login(&router, &owner.token, &renewal, "synthetic-renewed-key").await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{failed}");
    assert_eq!(failed["reason"], "account_removed");
    assert_eq!(session_status(&pool, &renewal).await, "failed");
    assert!(cloud_login_snapshots(&pool, &owner.account_id)
        .await
        .iter()
        .all(|snapshot| !snapshot.3));

    // A removed sign-in cannot be renewed afterwards either.
    let (status, rejected) = login_request(
        &router,
        &owner.token,
        "POST",
        "/start",
        Some(renew_body("anthropic", &choice)),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{rejected}");
}
