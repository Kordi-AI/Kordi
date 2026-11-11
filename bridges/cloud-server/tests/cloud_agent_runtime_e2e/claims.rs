use super::*;

#[tokio::test]
async fn cloud_agent_runtime_fallback_claim_is_idempotent_when_owner_is_offline() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(signup_email_fixture::state(pool.clone()));
    let router = test_router(state);
    let owner = signup(&router, "offline-owner", "Owner").await;
    let requester = signup(&router, "offline-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    let offline = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
        .await
        .unwrap();
    assert_eq!(offline.status(), StatusCode::OK);

    let first = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_agent_request_1"),
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_body = read_json(first).await;

    let second = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_agent_request_1"),
        ))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let second_body = read_json(second).await;

    assert_eq!(first_body["runId"], second_body["runId"]);
    assert_eq!(first_body["status"], "queued");
    assert_eq!(second_body["status"], "queued");
    let idempotency_key = claim_body(&owner, &requester, "msg_agent_request_1")["idempotencyKey"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        count_cloud_agent_runs_for_key(&pool, &idempotency_key).await,
        1
    );
}

#[tokio::test]
async fn cloud_agent_runtime_fallback_claim_does_not_wait_for_an_unready_online_mac() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(signup_email_fixture::state(pool.clone()));
    let router = test_router(state);
    let owner = signup(&router, "online-owner", "Owner").await;
    let requester = signup(&router, "online-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;

    sqlx_core::query::query(
        "UPDATE cloud_devices SET device_platform = 'macos' WHERE account_id = $1",
    )
    .bind(&owner.account_id)
    .execute(&pool)
    .await
    .unwrap();

    let online = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/online", &owner.token))
        .await
        .unwrap();
    assert_eq!(online.status(), StatusCode::OK);

    let first = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_online_owner"),
        ))
        .await
        .unwrap();

    assert_eq!(first.status(), StatusCode::OK);
    let first_body = read_json(first).await;
    assert_eq!(first_body["executionBackend"], "cloud");
    let idempotency_key = claim_body(&owner, &requester, "msg_online_owner")["idempotencyKey"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        count_cloud_agent_runs_for_key(&pool, &idempotency_key).await,
        1
    );
}

#[tokio::test]
async fn cloud_agent_runtime_fallback_claim_is_rejected_for_fresh_desktop_execution() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(signup_email_fixture::state(pool.clone()));
    let router = test_router(state);
    let owner = signup(&router, "processing-owner", "Owner").await;
    let request_message_id = format!("msg_processing_{}", uuid::Uuid::new_v4().simple());
    let session_id = format!("session:self-agent:{}", uuid::Uuid::new_v4().simple());
    let conversation_id = create_test_conversation(
        &pool,
        &owner.account_id,
        &session_id,
        ConversationKind::Ai,
        Vec::new(),
    )
    .await;
    insert_test_message(
        &pool,
        &owner.account_id,
        conversation_id,
        &encode_test_cloud_agent_processing_response(&request_message_id),
    )
    .await;

    let claim = claim_body_with_session(&owner, &owner, &request_message_id, &session_id);
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &owner.token,
            claim.clone(),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = read_json(response).await;
    assert_eq!(body["errorCode"], "owner_online");
    assert_eq!(
        count_cloud_agent_runs_for_key(&pool, claim["idempotencyKey"].as_str().unwrap()).await,
        0,
    );
}

#[tokio::test]
async fn cloud_agent_runtime_self_fallback_claim_has_one_durable_owner() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(signup_email_fixture::state(pool.clone()));
    let router = test_router(state);
    let account = signup(&router, "self-fallback", "Self").await;
    let request_message_id = format!("msg_self_{}", uuid::Uuid::new_v4().simple());
    let session_id = format!("session:self-agent:{}", uuid::Uuid::new_v4().simple());
    let claim = claim_body_with_session(&account, &account, &request_message_id, &session_id);

    let first = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &account.token,
            claim.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_body = read_json(first).await;

    let second = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &account.token,
            claim.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let second_body = read_json(second).await;

    assert_eq!(first_body["runId"], second_body["runId"]);
    assert_eq!(
        count_cloud_agent_runs_for_key(&pool, claim["idempotencyKey"].as_str().unwrap(),).await,
        1,
    );
}

#[tokio::test]
async fn cloud_agent_runtime_fallback_claim_requires_accepted_contact_or_self() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(signup_email_fixture::state(pool));
    let router = test_router(state);
    let owner = signup(&router, "unauth-owner", "Owner").await;
    let requester = signup(&router, "unauth-requester", "Requester").await;

    let offline = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
        .await
        .unwrap();
    assert_eq!(offline.status(), StatusCode::OK);

    let response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_unauthorized"),
        ))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn cloud_agent_runtime_claims_are_budgeted_per_requester() {
    use kordi_cloud_server::auth::rate_limit::AGENT_RUN_CLAIM_LIMIT;

    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(signup_email_fixture::state(pool));
    let setup = test_router(state.clone());
    let owner = signup(&setup, "budget-owner", "Owner").await;
    let requester = signup(&setup, "budget-requester", "Requester").await;
    accept_contacts(&setup, &requester, &owner).await;
    let offline = setup
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token))
        .await
        .unwrap();
    assert_eq!(offline.status(), StatusCode::OK);

    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig::production());
    for _ in 1..AGENT_RUN_CLAIM_LIMIT.limit {
        limiter
            .observe_account_limit(AGENT_RUN_CLAIM_LIMIT, &requester.account_id)
            .await;
    }
    let router = router_with_rate_limiter(state, limiter);

    let last_allowed = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_budget_last"),
        ))
        .await
        .unwrap();
    assert_eq!(last_allowed.status(), StatusCode::OK);

    let limited = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(&owner, &requester, "msg_budget_over"),
        ))
        .await
        .unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers().contains_key("retry-after"));
    assert_eq!(read_json(limited).await["errorCode"], "rate_limited");
}

#[tokio::test]
async fn an_agent_reply_that_mentions_another_agent_starts_no_run() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(signup_email_fixture::state(pool.clone()));
    let router = test_router(state);
    let source = signup(&router, "handoff-source", "Source").await;
    let target = signup(&router, "handoff-target", "Target").await;
    accept_contacts(&router, &source, &target).await;
    let session_id = format!("session:group:handoff-{}", uuid::Uuid::new_v4().simple());
    let request_message_id = format!("msg_agent_handoff_{}", uuid::Uuid::new_v4().simple());
    // An agent's reply that mentions another agent, as a client publishes it.
    let request_body = encode_test_cloud_group_envelope(json!({
        "kind": "group-message",
        "groupId": session_id,
        "groupSpaceId": session_id,
        "groupTitle": "Coordination",
        "createdByAccountId": source.account_id,
        "actor": { "accountId": source.account_id, "displayName": "Source", "role": "admin" },
        "participants": [
            { "accountId": source.account_id, "displayName": "Source", "role": "admin" },
            { "accountId": target.account_id, "displayName": "Target", "role": "person" }
        ],
        "message": {
            "id": request_message_id,
            "senderAccountId": source.account_id,
            "senderKind": "agent",
            "senderAgentId": format!("cloud-agent:{}", source.account_id),
            "senderDisplayName": "Kordi",
            "text": "@KordiTarget which day works for a bike ride?",
            "createdAtMs": 1,
            "targetCloudAgentOwnerAccountId": target.account_id,
            "targetCloudAgentId": format!("cloud-agent:{}", target.account_id),
            "targetCloudAgentOwnerName": "Target",
            "agentMentionDepth": 1
        }
    }));
    let conversation_id = create_test_conversation(
        &pool,
        &source.account_id,
        &session_id,
        ConversationKind::Group,
        vec![target.account_id.clone()],
    )
    .await;
    insert_test_message(&pool, &source.account_id, conversation_id, &request_body).await;

    // Neither the cloud admission nor the mentioned agent's Mac may run it.
    let claim_input = claim_body_with_session(&target, &source, &request_message_id, &session_id);
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &source.token,
            claim_input.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::FORBIDDEN);
    let mut desktop = claim_input;
    desktop["claimId"] = json!(uuid::Uuid::new_v4());
    let desktop = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/claim",
            &target.token,
            desktop,
        ))
        .await
        .unwrap();
    assert_ne!(desktop.status(), StatusCode::OK);
    let (runs,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT count(*) FROM cloud_agent_fallback_runs WHERE session_id=$1",
    )
    .bind(&session_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(runs, 0, "agents reach other agents only through reach_out");
}
