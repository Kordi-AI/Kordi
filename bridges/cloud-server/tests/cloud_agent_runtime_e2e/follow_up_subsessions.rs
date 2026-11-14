use super::*;

/// A background session restarted from a follow-up turn names the follow-up's
/// request id (`background-result:<session>:<status>`). It registers under the
/// person's original request, so the group shows its row, and later updates
/// that send the same follow-up id keep working.
#[tokio::test]
async fn a_task_restarted_from_a_follow_up_registers_under_the_original_request() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = signup(&router, "follow-up-task-owner", "Owner").await;
    let peer = signup(&router, "follow-up-task-peer", "Requester").await;
    accept_contacts(&router, &owner, &peer).await;
    let parent_id = format!("session:group:{}", uuid::Uuid::new_v4());
    let parent = create_test_conversation(
        &pool,
        &owner.account_id,
        &parent_id,
        ConversationKind::Group,
        vec![peer.account_id.clone()],
    )
    .await;
    let request_id = format!("msg:ui:{}", uuid::Uuid::new_v4());
    let envelope = json!({"kind":"group-message","groupId":parent_id,"groupSpaceId":parent_id,
        "createdByAccountId":owner.account_id,"actor":{"accountId":owner.account_id,"displayName":"Owner","role":"admin"},
        "participants":[{"accountId":owner.account_id,"displayName":"Owner","role":"admin"},{"accountId":peer.account_id,"displayName":"Requester","role":"person"}],
        "message":{"id":request_id,"senderAccountId":owner.account_id,"senderKind":"human","text":"Do a literature review","createdAtMs":1000,
            "targetCloudAgentId":format!("cloud-agent:{}",owner.account_id),"targetCloudAgentOwnerAccountId":owner.account_id}});
    let body = format!(
        "kordi-cloud-group:{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(envelope.to_string())
    );
    insert_test_message(&pool, &owner.account_id, parent, &body).await;
    let put = |id: uuid::Uuid, request: &str, version: i64, text: &str| {
        let snapshot = json!({"parentSessionId":parent_id,"parentRequestId":request,"title":"Literature review",
            "status":"running","expectedVersion":version,
            "messages":[{"id":"input","role":"user","text":text,"timestampMs":1000}]});
        Request::builder()
            .method("PUT")
            .uri(format!("/v1/cloud/agent-subsessions/{id}"))
            .header("authorization", format!("Bearer {}", owner.token))
            .header("content-type", "application/json")
            .body(Body::from(snapshot.to_string()))
            .unwrap()
    };

    let first = uuid::Uuid::new_v4();
    let created = router
        .clone()
        .oneshot(put(first, &request_id, 0, "Review the literature"))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::OK);

    // The restart, started by the follow-up turn that reported the failure.
    let follow_up = format!("background-result:{first}:failed");
    let restarted = uuid::Uuid::new_v4();
    let created = router
        .clone()
        .oneshot(put(
            restarted,
            &follow_up,
            0,
            "Review it with a tighter scope",
        ))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let created = read_json(created).await;
    assert_eq!(created["parentRequestId"], request_id.as_str(), "{created}");
    let updated = router
        .clone()
        .oneshot(put(
            restarted,
            &follow_up,
            created["version"].as_i64().unwrap(),
            "Review it with a tighter scope, step two",
        ))
        .await
        .unwrap();
    assert_eq!(updated.status(), StatusCode::OK);
    // A Mac that already sends the original request updates it too.
    let version = read_json(updated).await["version"].as_i64().unwrap();
    let updated = router
        .clone()
        .oneshot(put(restarted, &request_id, version, "Final step"))
        .await
        .unwrap();
    assert_eq!(updated.status(), StatusCode::OK);

    // A follow-up of a task the cloud never saw is still refused.
    let unknown = format!("background-result:{}:done", uuid::Uuid::new_v4());
    let refused = router
        .clone()
        .oneshot(put(uuid::Uuid::new_v4(), &unknown, 0, "Orphan"))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::NOT_FOUND);
}
