use super::calendar_availability::{insert_exchange, insert_run, read};
use super::*;
use sqlx_core::query::query;

async fn set_sharing(router: &axum::Router, owner: &TestAccount, share: bool) -> Value {
    let request = Request::builder()
        .method("PATCH")
        .uri("/v1/cloud/auth/me")
        .header("authorization", format!("Bearer {}", owner.token))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"shareCalendarAvailability":share}).to_string(),
        ))
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    read_json(response).await
}

#[tokio::test]
async fn another_members_agent_asks_the_owners_agent_for_busy_free_only() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = signup(&router, "member-availability-owner", "Owner").await;
    let peer = signup(&router, "member-availability-peer", "Peer").await;
    accept_contacts(&router, &owner, &peer).await;
    let event = json!({"id":"saved-dinner","title":"Private dinner","startAt":"2026-09-11T18:00:00Z","endAt":"2026-09-11T20:00:00Z","description":"Private notes","sourceIds":[]});
    query("INSERT INTO cloud_calendar_events(account_id,event_id,payload) VALUES($1,'saved-dinner',$2)")
        .bind(&owner.account_id).bind(&event).execute(&pool).await.unwrap();
    let session = format!(
        "session:group:member-availability-{}",
        uuid::Uuid::new_v4().simple()
    );
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &session,
        ConversationKind::Group,
        vec![peer.account_id.clone()],
    )
    .await;
    let peer_request = insert_test_message(
        &pool,
        &peer.account_id,
        conversation,
        "Plan Friday dinner with the owner's agent",
    )
    .await;

    // The peer's agent reaches out to the owner's agent: the target run is the
    // owner's agent, requested by the peer.
    let peer_root = insert_run(&pool, &session, &peer_request, &peer, &peer).await;
    let (target_request, _) =
        insert_exchange(&pool, &session, &peer_root, &peer, &peer, &owner).await;
    let availability = json!({"sessionId":session,"requestMessageId":target_request});
    let (status, body) = read(&router, &owner, availability.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["disclosure"], "availability");
    assert_eq!(body["scope"], "member_requested_shared_availability");
    assert_eq!(body["busyWindows"][0]["startAt"], "2026-09-11T18:00:00Z");
    let text = body.to_string();
    assert!(!text.contains("Private dinner") && !text.contains("saved-dinner"));
    // Details stay owner-request-only.
    for details in [
        json!({"sessionId":session,"requestMessageId":target_request,"shareInConversation":true}),
        json!({"sessionId":session,"requestMessageId":target_request,"disclosure":"details"}),
    ] {
        assert_eq!(
            read(&router, &owner, details).await.0,
            StatusCode::FORBIDDEN
        );
    }
    // The asking agent's owner never reads the owner's calendar directly.
    assert_eq!(
        read(&router, &peer, availability.clone()).await.0,
        StatusCode::FORBIDDEN
    );

    // A direct request from the peer, run by the owner's agent in the cloud.
    let run = insert_leased_scheduled_run(&pool, &owner, &peer, &session, "member-runner").await;
    query("UPDATE cloud_agent_fallback_runs SET request_message_id=$2,execution_backend='cloud' WHERE run_id=$1")
        .bind(&run).bind(&peer_request).execute(&pool).await.unwrap();
    let uri = format!("/v1/cloud/agent-runs/{run}/context");
    let context = |arguments: Value| {
        post_json_with_runner_token(
            &uri,
            "runner-test-token",
            json!({"runnerId":"member-runner","tool":"read_calendar","arguments":arguments}),
        )
    };
    let response = router.clone().oneshot(context(json!({}))).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert_eq!(body["disclosure"], "availability");
    assert!(!body.to_string().contains("Private dinner"));
    let response = router
        .clone()
        .oneshot(context(json!({"shareInConversation":true})))
        .await
        .unwrap();
    assert!(!response.status().is_success());

    // The owner can turn sharing off; their own requests are unaffected.
    let me = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/auth/me", &owner.token))
        .await
        .unwrap();
    assert_eq!(read_json(me).await["shareCalendarAvailability"], true);
    assert_eq!(
        set_sharing(&router, &owner, false).await["shareCalendarAvailability"],
        false
    );
    assert_eq!(
        read(&router, &owner, availability.clone()).await.0,
        StatusCode::FORBIDDEN
    );
    let response = router.clone().oneshot(context(json!({}))).await.unwrap();
    assert!(!response.status().is_success());
    let owner_request =
        insert_test_message(&pool, &owner.account_id, conversation, "When am I free?").await;
    let (status, _) = read(
        &router,
        &owner,
        json!({"sessionId":session,"requestMessageId":owner_request}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    set_sharing(&router, &owner, true).await;
    assert_eq!(
        read(&router, &owner, availability.clone()).await.0,
        StatusCode::OK
    );

    // Child runs never read the calendar.
    query("UPDATE cloud_agent_fallback_runs SET parent_run_id=$2 WHERE request_message_id=$1")
        .bind(&target_request)
        .bind(&peer_root)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        read(&router, &owner, availability.clone()).await.0,
        StatusCode::FORBIDDEN
    );
    query("UPDATE cloud_agent_fallback_runs SET parent_run_id=NULL WHERE request_message_id=$1")
        .bind(&target_request)
        .execute(&pool)
        .await
        .unwrap();

    // System never asks for, or reads, anyone's calendar.
    kordi_cloud_server::system_account::join(&pool, conversation)
        .await
        .unwrap();
    let system_request = insert_test_message(
        &pool,
        kordi_cloud_server::system_account::SYSTEM_ACCOUNT_ID,
        conversation,
        "When is everyone free?",
    )
    .await;
    let (status, _) = read(
        &router,
        &owner,
        json!({"sessionId":session,"requestMessageId":system_request}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    query("UPDATE cloud_agent_fallback_runs SET owner_account_id=$2 WHERE run_id=$1")
        .bind(&run)
        .bind(kordi_cloud_server::system_account::SYSTEM_ACCOUNT_ID)
        .execute(&pool)
        .await
        .unwrap();
    let response = router.clone().oneshot(context(json!({}))).await.unwrap();
    assert!(!response.status().is_success());

    // A requester who left the conversation cannot ask any more.
    query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE conversation_id=$1 AND account_id=$2")
        .bind(conversation).bind(&peer.account_id).execute(&pool).await.unwrap();
    assert_eq!(
        read(&router, &owner, availability).await.0,
        StatusCode::FORBIDDEN
    );
}
