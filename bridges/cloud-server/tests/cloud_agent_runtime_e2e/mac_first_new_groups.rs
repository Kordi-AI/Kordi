//! Mac-first holds for every request while the owner's Mac is online, also in
//! a group the Mac has not published anywhere yet and while the Mac has
//! withdrawn its readiness for a moment, as it does when its runtime reloads
//! after the owner picks another model or account.

use super::hosted_only_admission::runner_can_lease;
use super::*;
use sqlx_core::query::query;

struct Fixture {
    pool: sqlx_postgres::PgPool,
    router: axum::Router,
    owner: TestAccount,
    session: String,
    logical_id: String,
    wire_id: String,
}

/// An owner whose Mac is online but has withdrawn its readiness, and an
/// @mention of the owner's agent in a group created just now.
async fn fixture(prefix: &str) -> Option<Fixture> {
    let pool = try_pool().await?;
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = signup(&router, &format!("{prefix}-owner"), "Owner").await;
    let peer = signup(&router, &format!("{prefix}-peer"), "Peer").await;
    accept_contacts(&router, &owner, &peer).await;
    query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(&pool)
        .await
        .unwrap();
    let default_agent = format!("cloud-agent:{}", owner.account_id);
    for (uri, body) in [
        ("/v1/cloud/presence/online", None),
        (
            "/v1/cloud/agent-runs/desktop/ready",
            Some(json!({ "agentIds": [default_agent] })),
        ),
        // The runtime reloads: the Mac withdraws its readiness.
        (
            "/v1/cloud/agent-runs/desktop/ready",
            Some(json!({ "agentIds": [] })),
        ),
    ] {
        let request = match body {
            Some(body) => post_json_with_token(uri, &owner.token, body),
            None => post_with_token(uri, &owner.token),
        };
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    // Keep the Mac online regardless of test scheduling delays.
    query("UPDATE cloud_device_presence SET last_heartbeat_at=(now()+interval '10 minutes')::text WHERE account_id=$1")
        .bind(&owner.account_id).execute(&pool).await.unwrap();
    let session = format!("session:group:{}", uuid::Uuid::new_v4());
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &session,
        ConversationKind::Group,
        vec![peer.account_id.clone()],
    )
    .await;
    let logical_id = format!("desktop_{}", uuid::Uuid::new_v4());
    let participants = json!([
        {"accountId": owner.account_id, "displayName": "Owner", "role": "admin"},
        {"accountId": peer.account_id, "displayName": "Peer", "role": "person"},
    ]);
    let envelope = json!({
        "kind": "group-message", "groupId": session, "groupSpaceId": session,
        "createdByAccountId": owner.account_id, "actor": participants[0],
        "participants": participants,
        "message": {
            "id": logical_id, "senderAccountId": owner.account_id, "senderKind": "human",
            "text": "@Kordi reply once", "createdAtMs": chrono::Utc::now().timestamp_millis(),
            "targetCloudAgentId": default_agent,
            "targetCloudAgentOwnerAccountId": owner.account_id,
            "targetCloudAgentName": "Kordi",
        },
    });
    let body = encode_test_cloud_group_envelope(envelope);
    let wire_id = insert_test_message(&pool, &owner.account_id, conversation, &body).await;
    Some(Fixture {
        pool,
        router,
        owner,
        session,
        logical_id,
        wire_id,
    })
}

impl Fixture {
    fn body(&self, request_message_id: &str, claim_id: Option<uuid::Uuid>) -> Value {
        let mut body = json!({
            "requestMessageId": request_message_id,
            "sessionId": self.session,
            "ownerAccountId": self.owner.account_id,
            "requesterAccountId": self.owner.account_id,
            "prompt": "Reply once",
            "idempotencyKey": format!("shared:{}:{}", self.logical_id, self.owner.account_id),
            // The group agent runs on a saved ChatGPT account.
            "runtimeRoute": {
                "defaultModel": "openai-codex/gpt-5.5",
                "defaultAuthProvider": "openai-codex",
                "defaultAuthChoice": "cloud-login:synthetic",
            },
        });
        if let Some(claim_id) = claim_id {
            body["claimId"] = json!(claim_id);
        }
        body
    }

    async fn post(&self, uri: &str, body: Value) -> Value {
        let request = post_json_with_token(uri, &self.owner.token, body);
        let response = self.router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        read_json(response).await
    }

    /// The sender's cloud fallback claim right after the send.
    async fn request_claim(&self) -> Value {
        let body = self.body(&self.logical_id, None);
        self.post("/v1/cloud/agent-runs/claim", body).await
    }

    /// The Mac publishes its readiness again and claims the mention.
    async fn mac_claim(&self) -> Value {
        let ready = json!({ "agentIds": [format!("cloud-agent:{}", self.owner.account_id)] });
        self.post("/v1/cloud/agent-runs/desktop/ready", ready).await;
        let body = self.body(&self.wire_id, Some(uuid::Uuid::new_v4()));
        self.post("/v1/cloud/agent-runs/desktop/claim", body).await
    }

    async fn held_for_mac(&self, run_id: &str) -> bool {
        let held: (bool,) = sqlx_core::query_as::query_as(
            "SELECT COALESCE(desktop_preferred_until > now(), FALSE) FROM cloud_agent_fallback_runs WHERE run_id=$1",
        )
        .bind(run_id)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        held.0
    }

    /// The runs of this group, which the test then ends so that no later
    /// lease of another test picks them up.
    async fn runs(&self) -> Vec<(String, String)> {
        let runs = sqlx_core::query_as::query_as(
            "SELECT status, execution_backend FROM cloud_agent_fallback_runs WHERE session_id=$1",
        )
        .bind(&self.session)
        .fetch_all(&self.pool)
        .await
        .unwrap();
        query("UPDATE cloud_agent_fallback_runs SET status='cancelled' WHERE session_id=$1")
            .bind(&self.session)
            .execute(&self.pool)
            .await
            .unwrap();
        runs
    }
}

#[tokio::test]
async fn an_online_mac_gets_a_new_group_request_while_its_readiness_reloads() {
    let Some(fx) = fixture("mac-first-new-group").await else {
        return;
    };
    let held = fx.request_claim().await;
    assert_eq!(held["status"], "queued");
    let run_id = held["runId"].as_str().unwrap();
    assert!(fx.held_for_mac(run_id).await, "an online Mac goes first");
    assert!(!runner_can_lease(&fx.router, run_id).await);

    let claimed = fx.mac_claim().await;
    assert_eq!(claimed["runId"], run_id);
    assert_eq!(claimed["acquired"], true);
    assert!(!runner_can_lease(&fx.router, run_id).await);
    assert_eq!(fx.runs().await, vec![("leased".into(), "desktop".into())]);
}

#[tokio::test]
async fn the_cloud_answers_a_new_group_request_no_online_mac_claims() {
    let Some(fx) = fixture("mac-first-new-group-silent").await else {
        return;
    };
    let run_id = fx.request_claim().await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(fx.held_for_mac(&run_id).await);
    query("UPDATE cloud_agent_fallback_runs SET desktop_preferred_until=now()-interval '1 second' WHERE run_id=$1")
        .bind(&run_id).execute(&fx.pool).await.unwrap();
    assert!(runner_can_lease(&fx.router, &run_id).await, "the hold ends");
    assert!(!runner_can_lease(&fx.router, &run_id).await, "leased once");
    assert_eq!(fx.mac_claim().await["acquired"], false);
    assert_eq!(fx.runs().await, vec![("leased".into(), "cloud".into())]);
}

#[tokio::test]
async fn a_signed_off_mac_gets_no_hold_for_a_new_group_request() {
    let Some(fx) = fixture("mac-first-new-group-off").await else {
        return;
    };
    query("UPDATE cloud_device_presence SET state='offline', last_offline_at=now()::text WHERE account_id=$1")
        .bind(&fx.owner.account_id).execute(&fx.pool).await.unwrap();
    let run_id = fx.request_claim().await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(!fx.held_for_mac(&run_id).await);
    assert!(runner_can_lease(&fx.router, &run_id).await);
    assert_eq!(fx.runs().await, vec![("leased".into(), "cloud".into())]);
}
