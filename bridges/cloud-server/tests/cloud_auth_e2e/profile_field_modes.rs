//! Automatic Location and Time zone (#2439): modes are owner-only, devices
//! write only automatic fields, and a manual value is never overwritten.

use super::*;

async fn me(router: &axum::Router, token: &str) -> serde_json::Value {
    read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/auth/me", token))
            .await
            .unwrap(),
    )
    .await
}

async fn patch(router: &axum::Router, token: &str, body: serde_json::Value) -> serde_json::Value {
    let response = router
        .clone()
        .oneshot(patch_json_with_token("/v1/cloud/auth/me", token, body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    read_json(response).await
}

async fn device(
    router: &axum::Router,
    token: &str,
    body: serde_json::Value,
) -> axum::response::Response {
    router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/auth/me/device-profile",
            token,
            body,
        ))
        .await
        .unwrap()
}

#[tokio::test]
async fn new_accounts_start_with_automatic_time_zone_and_location_off() {
    let Some(pool) = try_pool().await else { return };
    let router = fast_router(Arc::new(signup_email_fixture::state(pool)));
    let (owner_token, owner_id) = signup_account(&router, "modes-owner").await;
    let (viewer_token, _) = signup_account(&router, "modes-viewer").await;

    let account = me(&router, &owner_token).await;
    assert_eq!(account["locationMode"], "manual");
    assert_eq!(account["timeZoneMode"], "automatic");

    // A device fills the automatic time zone; the location stays off.
    let response = device(
        &router,
        &owner_token,
        json!({ "timeZone": "America/Los_Angeles", "location": "Palo Alto, CA" }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let account = read_json(response).await;
    assert_eq!(account["timeZone"], "America/Los_Angeles");
    assert!(
        account["location"].is_null(),
        "location stays off until turned on"
    );

    // Turning location on stores the city with its mode.
    let account = patch(
        &router,
        &owner_token,
        json!({ "location": "Palo Alto, CA", "locationMode": "automatic" }),
    )
    .await;
    assert_eq!(account["location"], "Palo Alto, CA");
    assert_eq!(account["locationMode"], "automatic");

    let account = read_json(
        device(
            &router,
            &owner_token,
            json!({ "timeZone": "Asia/Riyadh", "location": "Thuwal, Saudi Arabia" }),
        )
        .await,
    )
    .await;
    assert_eq!(account["timeZone"], "Asia/Riyadh");
    assert_eq!(account["location"], "Thuwal, Saudi Arabia");

    // Others see the values but never the modes.
    let profile = read_json(
        router
            .clone()
            .oneshot(get_with_token(
                &format!("/v1/cloud/accounts/{owner_id}/profile"),
                &viewer_token,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(profile["location"], "Thuwal, Saudi Arabia");
    assert_eq!(profile["timeZone"], "Asia/Riyadh");
    assert!(profile.get("locationMode").is_none());
    assert!(profile.get("timeZoneMode").is_none());
}

#[tokio::test]
async fn manual_values_are_never_overwritten_by_devices() {
    let Some(pool) = try_pool().await else { return };
    let router = fast_router(Arc::new(signup_email_fixture::state(pool)));
    let (token, _) = signup_account(&router, "modes-manual").await;

    // A typed value without a mode becomes manual, as older clients send it.
    let account = patch(
        &router,
        &token,
        json!({ "location": "Bay Area", "timeZone": "America/New_York" }),
    )
    .await;
    assert_eq!(account["locationMode"], "manual");
    assert_eq!(account["timeZoneMode"], "manual");

    let response = device(
        &router,
        &token,
        json!({ "timeZone": "Asia/Riyadh", "location": "Thuwal, Saudi Arabia" }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let account = read_json(response).await;
    assert_eq!(account["location"], "Bay Area");
    assert_eq!(account["timeZone"], "America/New_York");

    // Clearing the time zone the old way turns it back to automatic.
    let account = patch(&router, &token, json!({ "timeZone": null })).await;
    assert_eq!(account["timeZoneMode"], "automatic");
    assert_eq!(account["locationMode"], "manual");
    // Saving an unchanged value keeps the mode.
    let account = patch(&router, &token, json!({ "location": "Bay Area" })).await;
    assert_eq!(account["locationMode"], "manual");
    let account =
        read_json(device(&router, &token, json!({ "timeZone": "Asia/Riyadh" })).await).await;
    assert_eq!(account["timeZone"], "Asia/Riyadh");
    assert_eq!(account["location"], "Bay Area");

    // Switching to manual explicitly pins the current value.
    let account = patch(&router, &token, json!({ "timeZoneMode": "manual" })).await;
    assert_eq!(account["timeZoneMode"], "manual");
    let account =
        read_json(device(&router, &token, json!({ "timeZone": "Europe/Lisbon" })).await).await;
    assert_eq!(account["timeZone"], "Asia/Riyadh");
}

#[tokio::test]
async fn device_profile_rejects_invalid_values_and_modes() {
    let Some(pool) = try_pool().await else { return };
    let router = fast_router(Arc::new(signup_email_fixture::state(pool)));
    let (token, _) = signup_account(&router, "modes-invalid").await;
    for (body, code) in [
        (json!({ "timeZone": "Mars/Olympus" }), "invalid_time_zone"),
        (
            json!({ "location": "Line one\nLine two" }),
            "invalid_location",
        ),
    ] {
        let response = device(&router, &token, body).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{code}");
        assert_eq!(read_json(response).await["errorCode"], code);
    }
    let response = router
        .clone()
        .oneshot(patch_json_with_token(
            "/v1/cloud/auth/me",
            &token,
            json!({ "locationMode": "device" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        read_json(response).await["errorCode"],
        "invalid_profile_field_mode"
    );
    let unauthenticated = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/auth/me/device-profile",
            "not-a-token",
            json!({ "timeZone": "Asia/Riyadh" }),
        ))
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn concurrent_manual_edit_and_device_write_keep_the_manual_value() {
    let Some(pool) = try_pool().await else { return };
    let router = fast_router(Arc::new(signup_email_fixture::state(pool)));
    let (token, _) = signup_account(&router, "modes-race").await;
    patch(
        &router,
        &token,
        json!({ "location": "Palo Alto, CA", "locationMode": "automatic" }),
    )
    .await;
    for round in 0..8 {
        let manual = format!("Typed place {round}");
        let (_, written) = tokio::join!(
            patch(
                &router,
                &token,
                json!({ "location": manual, "locationMode": "manual" }),
            ),
            device(
                &router,
                &token,
                json!({ "location": "Thuwal, Saudi Arabia" })
            ),
        );
        assert_eq!(written.status(), StatusCode::OK);
        let account = me(&router, &token).await;
        assert_eq!(account["locationMode"], "manual");
        assert_eq!(account["location"], manual.as_str(), "round {round}");
        patch(
            &router,
            &token,
            json!({ "location": "Palo Alto, CA", "locationMode": "automatic" }),
        )
        .await;
    }
}
