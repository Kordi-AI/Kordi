//! Catalog entries of Macs that are gone: removal, sign-out and aging.
use super::project_routing::{device_of, sign_in_another_mac, signup_with_email};
use super::projects::put;
use super::*;
use sqlx_core::query::query;

async fn publish(router: &axum::Router, token: &str, projects: Value) {
    let response = router
        .clone()
        .oneshot(put(
            token,
            "/v1/cloud/projects",
            json!({ "projects": projects }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

async fn catalog(router: &axum::Router, token: &str) -> Vec<Value> {
    let body = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/projects", token))
            .await
            .unwrap(),
    )
    .await;
    body["devices"].as_array().unwrap().clone()
}

async fn listed_devices(router: &axum::Router, token: &str) -> Vec<String> {
    let body = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/auth/devices", token))
            .await
            .unwrap(),
    )
    .await;
    body["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|device| device["deviceId"].as_str().unwrap().to_string())
        .collect()
}

async fn remove(router: &axum::Router, token: &str, path: &str) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(delete_with_token(path, token))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

async fn execute(pool: &sqlx_postgres::PgPool, sql: &str, device: &str) {
    query(sql).bind(device).execute(pool).await.unwrap();
}

async fn queue_command(pool: &sqlx_postgres::PgPool, account: &str, device: &str, project: &str) {
    query("INSERT INTO cloud_project_commands(command_id,account_id,device_id,request) VALUES($1,$2,$3,$4)")
        .bind(uuid::Uuid::new_v4())
        .bind(account)
        .bind(device)
        .bind(json!({"action":"assign","projectId":project}))
        .execute(pool)
        .await
        .unwrap();
}

async fn queued_projects(pool: &sqlx_postgres::PgPool, device: &str) -> Vec<String> {
    let rows: Vec<(String,)> = sqlx_core::query_as::query_as(
        "SELECT request->>'projectId' FROM cloud_project_commands WHERE device_id=$1 AND status='queued' ORDER BY 1",
    )
    .bind(device)
    .fetch_all(pool)
    .await
    .unwrap();
    rows.into_iter().map(|(project,)| project).collect()
}

async fn macs(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    prefix: &str,
) -> (TestAccount, String, String) {
    let email = unique_email(prefix);
    let owner = signup_with_email(router, &email).await;
    let first = sign_in_another_mac(router, &email).await;
    let second = sign_in_another_mac(router, &email).await;
    query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(pool)
        .await
        .unwrap();
    (owner, first, second)
}

#[tokio::test]
async fn offline_project_entries_are_removed_and_signed_out_macs_are_revoked() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let (owner, old_mac, current_mac) = macs(&router, &pool, "project-removal").await;
    let stranger = signup(&router, "project-removal-stranger", "Other").await;
    let old_device = device_of(&router, &old_mac).await;
    let project = "d".repeat(64);
    let other_project = "e".repeat(64);
    let session = format!("removed-{}", uuid::Uuid::new_v4());
    publish(
        &router,
        &old_mac,
        json!([
            {"id": project, "name": "Trust", "sessions": [session]},
            {"id": other_project, "name": "Website", "sessions": []},
        ]),
    )
    .await;
    publish(
        &router,
        &current_mac,
        json!([{"id": project, "name": "Trust", "sessions": []}]),
    )
    .await;
    let one = format!("/v1/cloud/projects/devices/{old_device}/projects/{project}");
    let whole = format!("/v1/cloud/projects/devices/{old_device}");

    let (status, body) = remove(&router, &owner.token, &one).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["errorCode"], "project_device_online");

    execute(
        &pool,
        "UPDATE cloud_project_devices SET updated_at=now()-interval '1 minute' WHERE device_id=$1",
        &old_device,
    )
    .await;
    queue_command(&pool, &owner.account_id, &old_device, &project).await;
    queue_command(&pool, &owner.account_id, &old_device, &other_project).await;
    assert_eq!(
        remove(&router, &stranger.token, &one).await.0,
        StatusCode::NOT_FOUND
    );

    // The Mac can still sign in, so only the project leaves the catalog.
    let (status, body) = remove(&router, &owner.token, &one).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["deviceRevoked"], false);
    assert_eq!(
        remove(&router, &owner.token, &one).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        queued_projects(&pool, &old_device).await,
        vec![other_project.clone()]
    );
    let devices = catalog(&router, &owner.token).await;
    let old = devices
        .iter()
        .find(|d| d["id"] == old_device.as_str())
        .unwrap();
    assert_eq!(old["online"], false);
    assert_eq!(
        old["projects"],
        json!([{"id": other_project, "name": "Website", "sessions": []}])
    );
    // Its sessions are no longer bound to the removed project.
    assert!(kordi_cloud_server::projects::project_session_binding(
        &pool,
        &owner.account_id,
        &session
    )
    .await
    .unwrap()
    .is_none());

    // Without a live session, removing one of several projects keeps the
    // Mac and its other projects.
    execute(
        &pool,
        "UPDATE cloud_refresh_tokens SET revoked_at=now()::text WHERE device_id=$1",
        &old_device,
    )
    .await;
    let kept = "f".repeat(64);
    execute(
        &pool,
        &format!(
            "UPDATE cloud_project_devices SET projects=projects || '[{{\"id\":\"{kept}\",\"name\":\"Notes\",\"sessions\":[]}}]'::jsonb WHERE device_id=$1"
        ),
        &old_device,
    )
    .await;
    let (status, body) = remove(
        &router,
        &owner.token,
        &format!("/v1/cloud/projects/devices/{old_device}/projects/{other_project}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["deviceRevoked"], false);
    let devices = catalog(&router, &owner.token).await;
    let old = devices
        .iter()
        .find(|d| d["id"] == old_device.as_str())
        .unwrap();
    assert_eq!(
        old["projects"],
        json!([{"id": kept, "name": "Notes", "sessions": []}])
    );

    // Removing the Mac's whole entry then revokes the Mac.
    let (status, body) = remove(&router, &owner.token, &whole).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["deviceRevoked"], true);
    assert!(queued_projects(&pool, &old_device).await.is_empty());
    let revoked: (Option<String>,) =
        sqlx_core::query_as::query_as("SELECT revoked_at FROM cloud_devices WHERE device_id=$1")
            .bind(&old_device)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(revoked.0.is_some());
    let devices = catalog(&router, &owner.token).await;
    assert_eq!(devices.len(), 1);
    assert_ne!(devices[0]["id"], old_device.as_str());
    assert_eq!(
        remove(&router, &owner.token, &whole).await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn idle_project_macs_stay_listed_until_they_age_out_or_sign_out() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let (owner, idle_mac, leaving_mac) = macs(&router, &pool, "project-aging").await;
    let idle_device = device_of(&router, &idle_mac).await;
    let leaving_device = device_of(&router, &leaving_mac).await;
    let project = "f".repeat(64);
    let session = format!("aging-{}", uuid::Uuid::new_v4());
    let catalog_entry = json!([{"id": project, "name": "Trust", "sessions": [session]}]);
    publish(&router, &idle_mac, catalog_entry.clone()).await;
    publish(&router, &leaving_mac, catalog_entry).await;

    // Idle for days: hidden from Active sessions before, listed now while it
    // still publishes projects.
    execute(
        &pool,
        "UPDATE cloud_project_devices SET updated_at=now()-interval '40 days' WHERE device_id=$1",
        &idle_device,
    )
    .await;
    execute(
        &pool,
        "UPDATE cloud_devices SET last_seen_at=(now()-interval '5 days')::text WHERE device_id=$1",
        &idle_device,
    )
    .await;
    let has = |devices: &[Value], id: &str| devices.iter().any(|d| d["id"] == id);
    assert!(has(&catalog(&router, &owner.token).await, &idle_device));
    assert!(listed_devices(&router, &owner.token)
        .await
        .contains(&idle_device));

    // Signed out and silent for 30 days: gone from the catalog, Active
    // sessions and routing.
    execute(
        &pool,
        "UPDATE cloud_refresh_tokens SET revoked_at=now()::text WHERE device_id=$1",
        &idle_device,
    )
    .await;
    assert!(!has(&catalog(&router, &owner.token).await, &idle_device));
    assert!(!listed_devices(&router, &owner.token)
        .await
        .contains(&idle_device));
    execute(
        &pool,
        "UPDATE cloud_project_devices SET updated_at=now()-interval '10 days' WHERE device_id=$1",
        &idle_device,
    )
    .await;
    assert!(has(&catalog(&router, &owner.token).await, &idle_device));
    assert!(listed_devices(&router, &owner.token)
        .await
        .contains(&idle_device));

    // Signing out with the Mac's last session removes its entry.
    let response = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/auth/logout", &leaving_mac))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(!has(&catalog(&router, &owner.token).await, &leaving_device));
    let binding =
        kordi_cloud_server::projects::project_session_binding(&pool, &owner.account_id, &session)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(binding.device_id, idle_device);
    assert!(!binding.device_online);

    // A Mac revoked from Active sessions leaves the catalog with it.
    let mut revoke = post_json_with_token(
        &format!("/v1/cloud/auth/devices/{idle_device}"),
        &owner.token,
        json!({"clientOperationId": uuid::Uuid::new_v4()}),
    );
    *revoke.method_mut() = axum::http::Method::DELETE;
    assert_eq!(
        router.clone().oneshot(revoke).await.unwrap().status(),
        StatusCode::OK
    );
    assert!(catalog(&router, &owner.token).await.is_empty());
    assert!(kordi_cloud_server::projects::project_session_binding(
        &pool,
        &owner.account_id,
        &session
    )
    .await
    .unwrap()
    .is_none());
}
