use super::*;
use sqlx_core::query::query;

async fn insert_run(
    pool: &sqlx_postgres::PgPool,
    session: &str,
    request: &str,
    owner: &TestAccount,
    requester: &TestAccount,
) -> String {
    let run = format!("run_{}", uuid::Uuid::new_v4().simple());
    query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at) VALUES($1,$1,$2,$3,$4,$5,'completed','Plan',now()::text,now()::text)")
        .bind(&run).bind(request).bind(session).bind(&owner.account_id).bind(&requester.account_id)
        .execute(pool).await.unwrap();
    run
}

/// Records an exchange whose original run is `root` and returns the synthetic
/// request ids of the target run and the owner's continuation run.
async fn insert_exchange(
    pool: &sqlx_postgres::PgPool,
    session: &str,
    root: &str,
    owner: &TestAccount,
    root_requester: &TestAccount,
    target: &TestAccount,
) -> (String, String) {
    let id = uuid::Uuid::new_v4();
    let target_request = format!("agent-exchange:{id}:request");
    let resume_request = format!("agent-exchange:{id}:resume");
    let target_run = insert_run(pool, session, &target_request, target, root_requester).await;
    let resume_run = insert_run(pool, session, &resume_request, owner, root_requester).await;
    query("INSERT INTO cloud_agent_exchanges(exchange_id,parent_run_id,root_run_id,request_key,target_owner_id,target_agent_id,request_text,target_run_id,resume_run_id,status) VALUES($1,$2,$2,'call',$3,'agent',$4,$5,$6,'resuming')")
        .bind(id).bind(root).bind(&target.account_id).bind("When are you free on Friday?")
        .bind(&target_run).bind(&resume_run).execute(pool).await.unwrap();
    (target_request, resume_request)
}

async fn read(router: &axum::Router, account: &TestAccount, body: Value) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/calendar/read",
            &account.token,
            body,
        ))
        .await
        .unwrap();
    let status = response.status();
    let body = if status.is_success() {
        read_json(response).await
    } else {
        Value::Null
    };
    (status, body)
}

#[tokio::test]
async fn shared_availability_reads_strip_event_content_and_follow_only_the_owners_request() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = signup(&router, "availability-owner", "Owner").await;
    let peer = signup(&router, "availability-peer", "Peer").await;
    accept_contacts(&router, &owner, &peer).await;
    let event = json!({"id":"saved-dinner","title":"Private dinner","startAt":"2026-09-11T18:00:00Z","endAt":"2026-09-11T20:00:00Z","description":"Private notes","links":["https://example.test/private"],"sourceIds":[]});
    query("INSERT INTO cloud_calendar_events(account_id,event_id,payload) VALUES($1,'saved-dinner',$2)")
        .bind(&owner.account_id).bind(&event).execute(&pool).await.unwrap();
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        "session:direct-person:availability",
        ConversationKind::Direct,
        vec![peer.account_id.clone()],
    )
    .await;
    // Direct conversations use the canonical direct-person session id.
    let (session,): (String,) = sqlx_core::query_as::query_as(
        "SELECT legacy_session_id FROM cloud_chat_conversations WHERE conversation_id=$1",
    )
    .bind(conversation)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(session.starts_with("session:direct-person:"));
    let owner_request = insert_test_message(
        &pool,
        &owner.account_id,
        conversation,
        "Work out a plan for Friday dinner with their agent",
    )
    .await;
    let peer_request = insert_test_message(
        &pool,
        &peer.account_id,
        conversation,
        "When is the owner free?",
    )
    .await;

    let (status, body) = read(
        &router,
        &owner,
        json!({"sessionId":session,"requestMessageId":owner_request,"disclosure":"availability"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["disclosure"], "availability");
    assert_eq!(body["scope"], "owner_requested_shared_availability");
    assert_eq!(body["busyWindows"][0]["startAt"], "2026-09-11T18:00:00Z");
    assert_eq!(body["busyWindows"][0]["endAt"], "2026-09-11T20:00:00Z");
    assert!(body.get("events").is_none());
    let text = body.to_string();
    for private in [
        "saved-dinner",
        "Private dinner",
        "Private notes",
        "example.test",
    ] {
        assert!(!text.contains(private), "{private} leaked");
    }

    // Continuing the owner's request after another agent replied keeps availability only.
    let root = insert_run(&pool, &session, &owner_request, &owner, &owner).await;
    let (target_request, resume_request) =
        insert_exchange(&pool, &session, &root, &owner, &owner, &peer).await;
    for share in [false, true] {
        let (status, body) = read(
            &router,
            &owner,
            json!({"sessionId":session,"requestMessageId":resume_request,"shareInConversation":share}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["disclosure"], "availability");
        assert!(!body.to_string().contains("Private dinner"));
    }
    let denied = [
        // Details are never unlocked by a continuation.
        json!({"sessionId":session,"requestMessageId":resume_request,"disclosure":"details"}),
        // A request another agent sent never unlocks the calendar, even for the owner's own agent.
        json!({"sessionId":session,"requestMessageId":target_request}),
        json!({"sessionId":session,"requestMessageId":peer_request}),
        json!({"sessionId":"session:direct-person:other","requestMessageId":resume_request}),
    ];
    for body in denied {
        assert_eq!(read(&router, &owner, body).await.0, StatusCode::FORBIDDEN);
    }
    let (status, _) = read(
        &router,
        &peer,
        json!({"sessionId":session,"requestMessageId":resume_request}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // A continuation of a run another person requested cannot read the owner's calendar.
    let peer_root = insert_run(&pool, &session, &peer_request, &owner, &peer).await;
    let (_, peer_resume) = insert_exchange(&pool, &session, &peer_root, &owner, &peer, &peer).await;
    let (status, _) = read(
        &router,
        &owner,
        json!({"sessionId":session,"requestMessageId":peer_resume}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // An agent-authored message cannot unlock availability either.
    query("UPDATE cloud_chat_messages SET message_kind='assistant' WHERE message_id::text=$1")
        .bind(&owner_request)
        .execute(&pool)
        .await
        .unwrap();
    for request in [&owner_request, &resume_request] {
        let (status, _) = read(
            &router,
            &owner,
            json!({"sessionId":session,"requestMessageId":request}),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
}
