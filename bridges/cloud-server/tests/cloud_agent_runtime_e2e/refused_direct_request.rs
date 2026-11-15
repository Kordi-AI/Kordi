//! A person's direct-chat request for an agent they may not use (Access
//! "Only me", or the owner's "Use my agent" switch off) ends at once with one
//! final reply both people see, whichever claim reaches the server first. The
//! reply and the refusal are the generic ones, so nothing shows the owner's
//! choice (docs/contact-permissions.md).
use super::*;

struct DirectChat {
    router: axum::Router,
    pool: sqlx_postgres::PgPool,
    owner: TestAccount,
    peer: TestAccount,
    session: String,
    conversation: uuid::Uuid,
}

impl DirectChat {
    async fn new(prefix: &str) -> Option<Self> {
        let pool = try_pool().await?;
        let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
        let owner = signup(&router, &format!("{prefix}-owner"), "Owner").await;
        let peer = signup(&router, &format!("{prefix}-peer"), "Peer").await;
        accept_contacts(&router, &owner, &peer).await;
        let mut ids = [owner.account_id.clone(), peer.account_id.clone()];
        ids.sort();
        let session = format!("session:direct-person:{}:{}", ids[0], ids[1]);
        let conversation = create_test_conversation(
            &pool,
            &owner.account_id,
            &session,
            ConversationKind::Direct,
            vec![peer.account_id.clone()],
        )
        .await;
        Some(Self {
            router,
            pool,
            owner,
            peer,
            session,
            conversation,
        })
    }

    /// The peer mentions the owner's default agent; returns the wire id.
    async fn ask_owner_agent(&self) -> String {
        let agent = format!("cloud-agent:{}", self.owner.account_id);
        let request = json!({
            "schemaVersion":1,"kind":"message","text":"@KordiOwner hi",
            "mentions":[{"label":"KordiOwner","targetKind":"agent",
                "targetIdentityId":format!("agent:{agent}"),"humanId":self.owner.account_id,
                "agentId":agent,"startUtf16":0,"lengthUtf16":11,"displayText":"@KordiOwner"}],
            "targetCloudAgentId":agent,"targetCloudAgentOwnerAccountId":self.owner.account_id,
        });
        insert_test_message(
            &self.pool,
            &self.peer.account_id,
            self.conversation,
            &format!(
                "kordi-cloud-message:{}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(request.to_string())
            ),
        )
        .await
    }

    async fn send(&self, path: &str, token: &str, body: Value) -> (StatusCode, Value) {
        let response = self
            .router
            .clone()
            .oneshot(post_json_with_token(path, token, body))
            .await
            .unwrap();
        let status = response.status();
        (status, read_json(response).await)
    }

    /// The owner's Mac asks to run the peer's request.
    async fn mac_claim(&self, wire: &str) -> (StatusCode, Value) {
        let mut input = claim_body_with_session(&self.owner, &self.peer, wire, &self.session);
        input["claimId"] = json!(uuid::Uuid::new_v4());
        input["idempotencyKey"] = json!(format!("shared:{wire}:{}", self.owner.account_id));
        self.send(
            "/v1/cloud/agent-runs/desktop/claim",
            &self.owner.token,
            input,
        )
        .await
    }

    /// The peer's client asks the cloud to answer its own request.
    async fn cloud_claim(&self, wire: &str) -> (StatusCode, Value) {
        let input = claim_body_with_session(&self.owner, &self.peer, wire, &self.session);
        self.send("/v1/cloud/agent-runs/claim", &self.peer.token, input)
            .await
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

    async fn set_default_access(&self, scope: &str) {
        let path = format!(
            "/v1/cloud/agents/cloud-agent:{}/access",
            self.owner.account_id
        );
        self.put(&path, json!({"accessScope": scope})).await;
    }

    async fn set_use_my_agent(&self, allowed: bool) {
        let path = format!("/v1/cloud/contacts/{}/permissions", self.peer.account_id);
        self.put(&path, json!({"agentAccess": allowed})).await;
    }

    /// The runs recorded for `wire`: (run id, status, error code, error text).
    async fn runs(&self, wire: &str) -> Vec<(String, String, Option<String>, Option<String>)> {
        sqlx_core::query_as::query_as(
            "SELECT run_id, status, error_code, error_message FROM cloud_agent_fallback_runs \
             WHERE request_message_id=$1 AND owner_account_id=$2",
        )
        .bind(wire)
        .bind(&self.owner.account_id)
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }

    /// The agent replies to `wire` in the chat: (sender, delivery state, text).
    async fn replies(&self, wire: &str) -> Vec<(String, String, String)> {
        let rows: Vec<(String, String)> = sqlx_core::query_as::query_as(
            "SELECT sender_account_id, content #>> '{blocks,0,text}' FROM cloud_chat_messages \
             WHERE conversation_id=$1 AND deleted_at IS NULL \
               AND content #>> '{blocks,0,text}' LIKE 'kordi-cloud-agent-response:%'",
        )
        .bind(self.conversation)
        .fetch_all(&self.pool)
        .await
        .unwrap();
        rows.into_iter()
            .filter_map(|(sender, body)| {
                let encoded = body.strip_prefix("kordi-cloud-agent-response:")?;
                let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(encoded)
                    .ok()?;
                let value: Value = serde_json::from_slice(&bytes).ok()?;
                (value["requestId"] == json!(wire)).then(|| {
                    (
                        sender,
                        value["deliveryState"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned(),
                        value["text"].as_str().unwrap_or_default().to_owned(),
                    )
                })
            })
            .collect()
    }

    /// The request ended with one failed run and one final reply from the
    /// owner's agent, with the generic text. Returns the run id.
    async fn assert_ended_unavailable(&self, wire: &str) -> String {
        let runs = self.runs(wire).await;
        assert_eq!(runs.len(), 1, "one run ends the request: {runs:?}");
        let (run, status, code, text) = runs.into_iter().next().unwrap();
        assert_eq!(status, "failed");
        assert_eq!(code.as_deref(), Some("agent_not_available"));
        assert_eq!(text.as_deref(), Some("Owner's Kordi isn't available."));
        assert_eq!(
            self.replies(wire).await,
            vec![(
                self.owner.account_id.clone(),
                "failed".to_owned(),
                "Owner's Kordi isn't available.".to_owned(),
            )],
            "both people see one final reply"
        );
        run
    }
}

/// The refusal every route gives, which never names a reason.
fn assert_generic_refusal(status: StatusCode, body: &Value) {
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["errorCode"], json!("agent_not_available"), "{body}");
    assert_eq!(
        body["message"],
        json!("This agent isn't available."),
        "{body}"
    );
}

#[tokio::test]
async fn refused_direct_request_with_private_access_ends_at_once_for_both_people() {
    let Some(chat) = DirectChat::new("refused-direct-private").await else {
        return;
    };
    chat.set_default_access("private").await;

    // The owner's Mac reaches the request first: the refusal ends it.
    let wire = chat.ask_owner_agent().await;
    let (status, body) = chat.mac_claim(&wire).await;
    assert_generic_refusal(status, &body);
    let run = chat.assert_ended_unavailable(&wire).await;

    // Asking again changes nothing: no second run, no second reply.
    let (status, body) = chat.mac_claim(&wire).await;
    assert_generic_refusal(status, &body);
    let (status, body) = chat.cloud_claim(&wire).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["runId"], json!(run), "the peer gets the ended run");
    assert_eq!(body["status"], json!("failed"));
    assert_eq!(chat.assert_ended_unavailable(&wire).await, run);

    // Once the owner opens the agent again, a new request is admitted.
    chat.set_default_access("participant_conversations").await;
    let wire = chat.ask_owner_agent().await;
    let (status, body) = chat.cloud_claim(&wire).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_ne!(body["status"], json!("failed"), "{body}");
    assert!(chat.replies(&wire).await.is_empty());
}

#[tokio::test]
async fn refused_direct_request_with_use_my_agent_off_ends_the_same_way() {
    let Some(chat) = DirectChat::new("refused-direct-switch").await else {
        return;
    };
    chat.set_use_my_agent(false).await;

    // The peer's own claim reaches the server first: same run, same reply.
    let wire = chat.ask_owner_agent().await;
    let (status, body) = chat.cloud_claim(&wire).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], json!("failed"));
    let run = chat.assert_ended_unavailable(&wire).await;
    let (status, body) = chat.mac_claim(&wire).await;
    assert_generic_refusal(status, &body);
    assert_eq!(chat.assert_ended_unavailable(&wire).await, run);

    // A message that does not ask for the owner's agent is refused without
    // a reply, so no one can post a refusal as someone else's agent.
    let plain = insert_test_message(
        &chat.pool,
        &chat.peer.account_id,
        chat.conversation,
        "hello",
    )
    .await;
    let (status, body) = chat.mac_claim(&plain).await;
    assert_generic_refusal(status, &body);
    assert!(chat.runs(&plain).await.is_empty());
    assert!(chat.replies(&plain).await.is_empty());
}
