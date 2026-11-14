//! People in the owner's group chats can mention the owner's default agent
//! without being contacts (docs/contact-permissions.md). The owner's "Use my
//! agent" switch and the agent's Access still decide, and a former member is
//! refused. The Cloud and Mac claim paths apply the same rule.
use super::*;

struct Group {
    router: axum::Router,
    pool: sqlx_postgres::PgPool,
    owner: TestAccount,
    member: TestAccount,
    outsider: TestAccount,
    session: String,
    conversation: uuid::Uuid,
}

impl Group {
    async fn new(prefix: &str) -> Option<Self> {
        let pool = try_pool().await?;
        let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
        let owner = signup(&router, &format!("{prefix}-owner"), "Owner").await;
        let member = signup(&router, &format!("{prefix}-member"), "Member").await;
        let outsider = signup(&router, &format!("{prefix}-outsider"), "Outsider").await;
        // Group creation adds contacts only; then the contact rows go, which
        // leaves what a Grounding room invitation leaves: co-members who are
        // not contacts.
        accept_contacts(&router, &owner, &member).await;
        let session = format!("session:group:{}", uuid::Uuid::new_v4());
        let conversation = create_test_conversation(
            &pool,
            &owner.account_id,
            &session,
            ConversationKind::Group,
            vec![member.account_id.clone()],
        )
        .await;
        sqlx_core::query::query(
            "DELETE FROM cloud_contacts WHERE (account_id=$1 AND peer_account_id=$2) OR (account_id=$2 AND peer_account_id=$1)",
        )
        .bind(&owner.account_id)
        .bind(&member.account_id)
        .execute(&pool)
        .await
        .unwrap();
        Some(Self {
            router,
            pool,
            owner,
            member,
            outsider,
            session,
            conversation,
        })
    }

    /// The member asks the owner's default agent; returns (request id, wire id).
    async fn ask_owner_agent(&self) -> (String, String) {
        let request_id = format!("request-{}", uuid::Uuid::new_v4());
        let participants = json!([
            {"accountId":self.owner.account_id,"displayName":"Owner","agentDisplayName":"Kordi"},
            {"accountId":self.member.account_id,"displayName":"Member","agentDisplayName":"Kordi"}
        ]);
        let message = json!({
            "id":request_id,"senderAccountId":self.member.account_id,"senderKind":"human",
            "text":"@KordiOwner check status","createdAtMs":1,
            "mentions":[{"label":"KordiOwner","targetKind":"agent",
                "targetIdentityId":format!("agent:cloud-agent:{}",self.owner.account_id),
                "humanId":self.owner.account_id,"agentId":format!("cloud-agent:{}",self.owner.account_id),
                "startUtf16":0,"lengthUtf16":11,"displayText":"@KordiOwner"}]
        });
        let body = encode_test_cloud_group_envelope(json!({
            "kind":"group-message","groupId":self.session,"createdByAccountId":self.owner.account_id,
            "actor":participants[1],"participants":participants,"message":message
        }));
        let wire_id = insert_test_message(
            &self.pool,
            &self.member.account_id,
            self.conversation,
            &body,
        )
        .await;
        (request_id, wire_id)
    }

    async fn cloud_claim(&self, request_id: &str) -> StatusCode {
        self.router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/claim",
                &self.member.token,
                claim_body_with_session(&self.owner, &self.member, request_id, &self.session),
            ))
            .await
            .unwrap()
            .status()
    }

    /// The run that ended `request` and its reply text, if any.
    async fn ended_run(
        &self,
        request_id: &str,
    ) -> Option<(String, Option<String>, Option<String>, bool)> {
        sqlx_core::query_as::query_as(
            "SELECT status, error_code, error_message, response_message_id IS NOT NULL FROM cloud_agent_fallback_runs WHERE request_message_id=$1 AND owner_account_id=$2",
        )
        .bind(request_id)
        .bind(&self.owner.account_id)
        .fetch_optional(&self.pool)
        .await
        .unwrap()
    }

    /// A refused mention ends at once with one final reply every member sees.
    async fn assert_ended_unavailable(&self, request_id: &str) {
        let (status, code, text, replied) = self
            .ended_run(request_id)
            .await
            .expect("the refused mention ends with a run");
        assert_eq!(status, "failed");
        assert_eq!(code.as_deref(), Some("agent_not_available"));
        assert_eq!(text.as_deref(), Some("Owner's Kordi isn't available."));
        assert!(replied, "the final reply is posted in the group");
    }

    /// The owner's Mac claims the member's request.
    async fn mac_claim(&self, request_id: &str, wire_id: &str) -> (StatusCode, Value) {
        sqlx_core::query::query(
            "UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1",
        )
        .bind(&self.owner.account_id)
        .execute(&self.pool)
        .await
        .unwrap();
        let ready = self
            .router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/desktop/ready",
                &self.owner.token,
                json!({"agentIds":[format!("cloud-agent:{}",self.owner.account_id)]}),
            ))
            .await
            .unwrap();
        assert_eq!(ready.status(), StatusCode::OK);
        let mut input =
            claim_body_with_session(&self.owner, &self.member, request_id, &self.session);
        input["claimId"] = json!(uuid::Uuid::new_v4());
        input["requestMessageId"] = json!(wire_id);
        let response = self
            .router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/desktop/claim",
                &self.owner.token,
                input,
            ))
            .await
            .unwrap();
        let status = response.status();
        (status, read_json(response).await)
    }

    async fn clear_mac_readiness(&self) {
        sqlx_core::query::query("DELETE FROM cloud_agent_desktop_capabilities WHERE device_id IN(SELECT device_id FROM cloud_devices WHERE account_id=$1)")
            .bind(&self.owner.account_id)
            .execute(&self.pool)
            .await
            .unwrap();
    }

    async fn put(&self, path: &str, body: Value) {
        let request = Request::builder()
            .method("PUT")
            .uri(path)
            .header("authorization", format!("Bearer {}", self.owner.token))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = self.router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
    }

    async fn set_use_my_agent(&self, allowed: bool) {
        let path = format!("/v1/cloud/contacts/{}/permissions", self.member.account_id);
        self.put(&path, json!({"agentAccess": allowed})).await;
    }

    async fn set_default_access(&self, scope: &str) {
        let path = format!(
            "/v1/cloud/agents/cloud-agent:{}/access",
            self.owner.account_id
        );
        self.put(&path, json!({"accessScope": scope})).await;
    }

    async fn listed_default_agents(&self, viewer: &TestAccount, include: bool) -> Vec<Value> {
        let flag = if include {
            "&includeDefaultAgents=true"
        } else {
            ""
        };
        let response = self
            .router
            .clone()
            .oneshot(get_with_token(
                &format!(
                    "/v1/cloud/agents/shared?ownerAccountIds={}{flag}",
                    self.owner.account_id
                ),
                &viewer.token,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        read_json(response).await["agents"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|agent| agent["isDefaultAgent"] == json!(true))
            .collect()
    }
}

#[tokio::test]
async fn group_members_can_mention_each_others_default_agent_without_a_contact() {
    let Some(group) = Group::new("group-default-agent").await else {
        return;
    };
    assert!(
        !kordi_cloud_server::cloud_agent_runtime::runs::requester_can_target_owner(
            &group.pool,
            &group.member.account_id,
            &group.owner.account_id,
        )
        .await
        .unwrap(),
        "the fixture has no contact record"
    );

    // Cloud path: the co-member's request runs on the owner's default agent.
    let (request, _) = group.ask_owner_agent().await;
    assert_eq!(group.cloud_claim(&request).await, StatusCode::OK);
    let (runs,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT count(*) FROM cloud_agent_fallback_runs WHERE request_message_id=$1 AND owner_account_id=$2",
    )
    .bind(&request)
    .bind(&group.owner.account_id)
    .fetch_one(&group.pool)
    .await
    .unwrap();
    assert_eq!(runs, 1);

    // Mac path: the owner's Mac claims the co-member's request.
    let (request, wire) = group.ask_owner_agent().await;
    let (status, body) = group.mac_claim(&request, &wire).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["acquired"], json!(true), "{body}");
    group.clear_mac_readiness().await;
}

#[tokio::test]
async fn group_member_default_agent_mentions_follow_use_my_agent_access_and_membership() {
    let Some(group) = Group::new("group-default-agent-refusals").await else {
        return;
    };

    // "Use my agent" off: the Cloud claim ends the mention with a final
    // "isn't available" reply instead of a wait, and the owner's Mac is
    // refused without answering.
    group.set_use_my_agent(false).await;
    let (request, wire) = group.ask_owner_agent().await;
    assert_eq!(group.cloud_claim(&request).await, StatusCode::OK);
    group.assert_ended_unavailable(&request).await;
    let (status, body) = group.mac_claim(&request, &wire).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    group.clear_mac_readiness().await;

    // The owner's Mac reaching a stale mention first ends it the same way.
    let (request, wire) = group.ask_owner_agent().await;
    let (status, body) = group.mac_claim(&request, &wire).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    group.clear_mac_readiness().await;
    group.assert_ended_unavailable(&request).await;
    assert_eq!(group.cloud_claim(&request).await, StatusCode::OK);
    group.set_use_my_agent(true).await;

    // Access "Only me" ends it the same way.
    group.set_default_access("private").await;
    let (request, _) = group.ask_owner_agent().await;
    assert_eq!(group.cloud_claim(&request).await, StatusCode::OK);
    group.assert_ended_unavailable(&request).await;
    group.set_default_access("participant_conversations").await;

    // A former member is refused, even for a request sent while a member.
    let (request, wire) = group.ask_owner_agent().await;
    sqlx_core::query::query(
        "UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE conversation_id=$1 AND account_id=$2",
    )
    .bind(group.conversation)
    .bind(&group.member.account_id)
    .execute(&group.pool)
    .await
    .unwrap();
    assert_eq!(group.cloud_claim(&request).await, StatusCode::FORBIDDEN);
    let (status, body) = group.mac_claim(&request, &wire).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    group.clear_mac_readiness().await;

    assert!(
        group.ended_run(&request).await.is_none(),
        "a former member's request starts nothing"
    );
    let (runs,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT count(*) FROM cloud_agent_fallback_runs WHERE requester_account_id=$1 AND owner_account_id=$2 AND status <> 'failed'",
    )
    .bind(&group.member.account_id)
    .bind(&group.owner.account_id)
    .fetch_one(&group.pool)
    .await
    .unwrap();
    assert_eq!(runs, 0, "no refused mention ever runs");
}

#[tokio::test]
async fn shared_agent_list_offers_open_default_agents_to_group_members_only() {
    let Some(group) = Group::new("group-default-agent-list").await else {
        return;
    };
    // Older clients that do not ask keep the Factory-only list.
    assert!(group
        .listed_default_agents(&group.member, false)
        .await
        .is_empty());

    let listed = group.listed_default_agents(&group.member, true).await;
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!(
        listed[0]["agentId"],
        json!(format!("cloud-agent:{}", group.owner.account_id))
    );
    assert_eq!(listed[0]["ownerAccountId"], json!(group.owner.account_id));
    assert_eq!(listed[0]["accessScope"], json!("participant_conversations"));

    // Someone who shares no group with the owner, and the owner, see none.
    assert!(group
        .listed_default_agents(&group.outsider, true)
        .await
        .is_empty());
    assert!(group
        .listed_default_agents(&group.owner, true)
        .await
        .is_empty());

    group.set_use_my_agent(false).await;
    assert!(group
        .listed_default_agents(&group.member, true)
        .await
        .is_empty());
    group.set_use_my_agent(true).await;

    group.set_default_access("private").await;
    assert!(group
        .listed_default_agents(&group.member, true)
        .await
        .is_empty());
    // The Access change reaches the co-member at once, so their composer
    // refetches and stops offering the agent.
    let (hints,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT count(*) FROM cloud_chat_user_sync_events WHERE account_id=$1 AND event_type='agent.directory.changed' AND payload->>'ownerAccountId'=$2 AND payload->>'agentId'=$3",
    )
    .bind(&group.member.account_id)
    .bind(&group.owner.account_id)
    .bind(format!("cloud-agent:{}", group.owner.account_id))
    .fetch_one(&group.pool)
    .await
    .unwrap();
    assert!(hints >= 1, "the co-member gets agent.directory.changed");
}
