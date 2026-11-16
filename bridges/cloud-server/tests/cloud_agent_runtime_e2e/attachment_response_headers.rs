use axum::http::HeaderMap;

use super::*;

async fn upload(router: &axum::Router, token: &str, content_type: &str, bytes: &[u8]) -> String {
    let initiated = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/attachments/initiate", token))
        .await
        .unwrap();
    assert_eq!(initiated.status(), StatusCode::OK);
    let initiated = read_json(initiated).await;
    let attachment_id = initiated["attachmentId"].as_str().unwrap().to_string();
    let uploaded = router
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/v1/cloud/attachments/{attachment_id}/upload"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", content_type)
                .body(Body::from(bytes.to_vec()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(uploaded.status(), StatusCode::OK);
    attachment_id
}

fn assert_never_rendered(headers: &HeaderMap) {
    assert_eq!(
        headers["content-security-policy"],
        "sandbox; default-src 'none'"
    );
    assert_eq!(headers["x-content-type-options"], "nosniff");
}

#[tokio::test]
async fn attachment_content_is_never_rendered_as_a_page() {
    let Some(pool) = try_pool().await else {
        return;
    };
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool, &store);
    let owner = signup(&router, "headers-content", "Owner").await;
    let id = upload(
        &router,
        &owner.token,
        "text/html",
        b"<script>alert(1)</script>",
    )
    .await;

    let response = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/attachments/{id}/content"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_never_rendered(response.headers());
    assert_eq!(response.headers()["content-disposition"], "attachment");
}

#[tokio::test]
async fn attachment_preview_content_is_never_rendered_as_a_page() {
    let Some(pool) = try_pool().await else {
        return;
    };
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool, &store);
    let owner = signup(&router, "headers-preview", "Owner").await;
    let id = upload(&router, &owner.token, "application/octet-stream", b"bytes").await;

    let stored = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/attachments/{id}/preview"),
            &owner.token,
            json!({ "previewUrl": "data:image/png;base64,iVBORw==" }),
        ))
        .await
        .unwrap();
    assert_eq!(stored.status(), StatusCode::OK);

    let response = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/attachments/{id}/preview-content"),
            &owner.token,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_never_rendered(response.headers());
    assert_eq!(response.headers()["content-disposition"], "attachment");
}

async fn playback_response(
    router: &axum::Router,
    token: &str,
    id: &str,
) -> axum::response::Response {
    let minted = router
        .clone()
        .oneshot(post_with_token(
            &format!("/v1/cloud/attachments/{id}/playback"),
            token,
        ))
        .await
        .unwrap();
    assert_eq!(minted.status(), StatusCode::OK);
    let minted = read_json(minted).await;
    let path = minted["playbackPath"].as_str().unwrap();
    router
        .clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn playback_keeps_video_playable_and_downloads_everything_else() {
    let Some(pool) = try_pool().await else {
        return;
    };
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool, &store);
    let owner = signup(&router, "headers-playback", "Owner").await;

    const SECRET: &str = "KORDI_CHAT_SYNC_CURSOR_SECRET";
    let previous = std::env::var(SECRET).ok();
    std::env::set_var(SECRET, "attachment-headers-test-playback-secret-0123456789");

    let video = upload(
        &router,
        &owner.token,
        "video/mp4",
        b"\0\0\0\x18ftypmp42\0\0\0\0mp42isom",
    )
    .await;
    let page = upload(
        &router,
        &owner.token,
        "text/html",
        b"<script>alert(1)</script>",
    )
    .await;
    let video_response = playback_response(&router, &owner.token, &video).await;
    let page_response = playback_response(&router, &owner.token, &page).await;

    match previous {
        Some(value) => std::env::set_var(SECRET, value),
        None => std::env::remove_var(SECRET),
    }

    assert_eq!(video_response.status(), StatusCode::OK);
    assert_eq!(video_response.headers()["content-type"], "video/mp4");
    assert_never_rendered(video_response.headers());
    assert!(video_response
        .headers()
        .get("content-disposition")
        .is_none());

    assert_eq!(page_response.status(), StatusCode::OK);
    assert_never_rendered(page_response.headers());
    assert_eq!(page_response.headers()["content-disposition"], "attachment");
}
