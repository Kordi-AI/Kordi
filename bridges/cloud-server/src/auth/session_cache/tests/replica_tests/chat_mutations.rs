use super::*;
use crate::chat_sync::{
    models::{ConversationKind, CreateConversationRequest},
    store,
};
use axum::body::to_bytes;
use serde_json::{json, Value};

type Replica = (Arc<ServerState>, axum::Router);

fn cached(state: &ServerState, token: &str) -> bool {
    let hash = crate::auth::session::hash_session_token(token);
    matches!(
        state
            .session_signals()
            .lookup_cache()
            .probe(&hash, Instant::now(), Utc::now()),
        Probe::Hit(_)
    )
}

async fn request(
    app: &axum::Router,
    token: &str,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn message() -> Value {
    json!({"client_message_id":Uuid::now_v7(), "kind":"text", "content":{"schema":1,"blocks":[{"type":"text","text":"Synthetic cache test"}]}, "attachment_ids":[]})
}

async fn group(
    pool: &PgPool,
    owner: &str,
    peer: &str,
) -> crate::chat_sync::models::ConversationSnapshot {
    query("INSERT INTO cloud_contacts(account_id, peer_account_id, created_at) VALUES ($1,$2,$3),($2,$1,$3)")
        .bind(owner).bind(peer).bind(Utc::now().to_rfc3339()).execute(pool).await.unwrap();
    store::create_conversation(
        pool,
        owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Group,
            shared_title: Some("Synthetic group".into()),
            client_session_id: format!("synthetic:{}", Uuid::new_v4()),
            member_account_ids: vec![peer.to_owned()],
            organization_id: None,
        },
    )
    .await
    .unwrap()
    .value
}

async fn assert_cached_everywhere(pool: &PgPool, replicas: &[Replica], tokens: &[&str]) {
    for (state, _) in replicas {
        settle(state, pool).await;
        for token in tokens {
            assert!(
                cached(state, token),
                "chat work preserves cached session facts"
            );
        }
    }
}

#[tokio::test]
async fn successful_chat_mutations_preserve_sessions_but_errors_and_other_mutations_evict() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let previous = std::env::var("KORDI_CHAT_SYNC_CURSOR_SECRET").ok();
    std::env::set_var(
        "KORDI_CHAT_SYNC_CURSOR_SECRET",
        "synthetic-cache-test-cursor-key-0123456789",
    );
    let replicas = [replica(&pool).await, replica(&pool).await];
    let (owner, _, _, token) = signed_in(&pool).await;
    let (peer, _, _, peer_token) = signed_in(&pool).await;
    let conversation = group(&pool, &owner, &peer).await;
    let path = format!("/v2/chat/conversations/{}", conversation.id);
    for token in [&token, &peer_token] {
        cached_on_both(&pool, &replicas, token).await;
    }
    for (state, app) in &replicas {
        let (status, sent) =
            request(app, &token, "POST", &format!("{path}/messages"), message()).await;
        assert_eq!(status, StatusCode::CREATED);
        let snapshot = state.session_signals().lookup_cache().metrics().snapshot();
        for stage in [
            "handler",
            "store",
            "pool_wait",
            "begin",
            "operation_lock",
            "writer_authorization",
            "sequence_allocation",
            "fanout",
            "commit",
            "projection",
            "reply_matching",
            "mention_routing",
        ] {
            assert_eq!(snapshot["chat_send"][stage]["count"], 1, "{stage}");
            assert_eq!(snapshot["chat_send"][stage]["abandoned"], 0, "{stage}");
        }
        assert_eq!(snapshot["chat_send"]["notifications"]["count"], 0);
        assert_cached_everywhere(&pool, &replicas, &[&token, &peer_token]).await;
        for receipt in ["delivered", "read"] {
            let (status, _) = request(app, &peer_token, "PUT", &format!("{path}/{receipt}"), json!({"client_operation_id":Uuid::now_v7(),"sequence":sent["message"]["conversation_sequence"]})).await;
            assert_eq!(status, StatusCode::OK);
            assert_cached_everywhere(&pool, &replicas, &[&token, &peer_token]).await;
        }
        let (status, _) = request(
            app,
            &peer_token,
            "POST",
            "/v2/chat/realtime/ticket",
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_cached_everywhere(&pool, &replicas, &[&token, &peer_token]).await;
    }
    // Preserving a response cannot make the cache usable without a live listener.
    let cache = replicas[0].0.session_signals().lookup_cache();
    cache.set_listener_connected(false);
    let (status, _) = request(
        &replicas[0].1,
        &token,
        "POST",
        &format!("{path}/messages"),
        message(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert!(!cached(&replicas[0].0, &token));
    cache.set_listener_connected(true);
    cache.notification_received();
    cached_on_both(&pool, &replicas, &token).await;
    // Failed requests retain the conservative default even on opted-in routes.
    let (status, _) = request(
        &replicas[0].1,
        &token,
        "POST",
        &format!("{path}/messages"),
        json!({}),
    )
    .await;
    assert!(status.is_client_error());
    assert!(!cached(&replicas[0].0, &token));
    cached_on_both(&pool, &replicas, &token).await;
    // The adjacent conversation mutation was not opted in.
    let (current_version,): (i32,) = sqlx_core::query_as::query_as(
        "SELECT version FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(conversation.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let (status, _) = request(
        &replicas[0].1,
        &token,
        "PATCH",
        &path,
        json!({"client_operation_id":Uuid::now_v7(),"shared_title":"Synthetic changed title", "expected_version":current_version}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!cached(&replicas[0].0, &token));
    match previous {
        Some(value) => std::env::set_var("KORDI_CHAT_SYNC_CURSOR_SECRET", value),
        None => std::env::remove_var("KORDI_CHAT_SYNC_CURSOR_SECRET"),
    }
}

#[tokio::test]
async fn warm_chat_sessions_still_check_membership_and_device_revocation() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let replicas = [replica(&pool).await, replica(&pool).await];
    let (owner, _, _, token) = signed_in(&pool).await;
    let (peer, device, _, peer_token) = signed_in(&pool).await;
    let conversation = group(&pool, &owner, &peer).await;
    let path = format!("/v2/chat/conversations/{}", conversation.id);
    cached_on_both(&pool, &replicas, &peer_token).await;
    // A new chat write is authorized from current membership, not session facts.
    store::leave_group(
        &pool,
        &peer,
        conversation.legacy_session_id.as_deref().unwrap(),
    )
    .await
    .unwrap();
    for (state, app) in &replicas {
        // Rewarm explicitly so denial must happen even with a cache hit.
        assert_eq!(me(app, &peer_token).await, StatusCode::OK);
        assert!(cached(state, &peer_token));
        let (status, _) = request(
            app,
            &peer_token,
            "POST",
            &format!("{path}/messages"),
            message(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(me(app, &peer_token).await, StatusCode::OK);
        let (status, _) = request(
            app,
            &peer_token,
            "PUT",
            &format!("{path}/read"),
            json!({"client_operation_id":Uuid::now_v7(),"sequence":0}),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    cached_on_both(&pool, &replicas, &peer_token).await;
    query("UPDATE cloud_devices SET revoked_at = $1 WHERE device_id = $2")
        .bind(Utc::now().to_rfc3339())
        .bind(device)
        .execute(&pool)
        .await
        .unwrap();
    for (state, app) in &replicas {
        settle(state, &pool).await;
        let (status, _) = request(
            app,
            &peer_token,
            "POST",
            &format!("{path}/messages"),
            message(),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    // Revoking the peer leaves the owner's session usable.
    let (status, _) = request(
        &replicas[0].1,
        &token,
        "POST",
        &format!("{path}/messages"),
        message(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn successful_chat_response_cannot_restore_a_concurrently_revoked_session() {
    use crate::auth::{routes::cloud_session_middleware, session_cache::routes::preserve_session};
    let Some(pool) = test_pool().await else {
        return;
    };
    let replicas = [replica(&pool).await, replica(&pool).await];
    let (_, _, token_id, token) = signed_in(&pool).await;
    cached_on_both(&pool, &replicas, &token).await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let resume = Arc::new(tokio::sync::Notify::new());
    let handler = {
        let entered = entered.clone();
        let resume = resume.clone();
        move || {
            let entered = entered.clone();
            let resume = resume.clone();
            async move {
                entered.notify_one();
                resume.notified().await;
                StatusCode::NO_CONTENT
            }
        }
    };
    let app = axum::Router::new()
        .route(
            "/synthetic-chat",
            preserve_session(axum::routing::post(handler)),
        )
        .route_layer(axum::middleware::from_fn_with_state(
            replicas[0].0.clone(),
            cloud_session_middleware,
        ))
        .with_state(replicas[0].0.clone());
    let in_flight = Request::builder()
        .method("POST")
        .uri("/synthetic-chat")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let request = tokio::spawn(async move { app.oneshot(in_flight).await.unwrap() });
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    crate::auth::session::revoke_session(&pool, &token_id)
        .await
        .unwrap();
    for (state, _) in &replicas {
        settle(state, &pool).await;
        assert!(!cached(state, &token));
    }
    resume.notify_one();
    assert_eq!(request.await.unwrap().status(), StatusCode::NO_CONTENT);
    for (state, app) in &replicas {
        assert!(
            !cached(state, &token),
            "the completed response cannot refill the cache"
        );
        assert_eq!(me(app, &token).await, StatusCode::UNAUTHORIZED);
    }
}
