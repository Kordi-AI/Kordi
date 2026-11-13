//! The owner's private chat with their agent: the owner already reads every
//! reply there, so they are never a reach_out target, and a refused request
//! tells the agent why instead of a bare not-found.
use super::*;

impl Fixture {
    /// Turns the fixture's direct chat into the owner's private agent chat;
    /// `with_contact` keeps Beta as a member who joined it.
    async fn own_chat(&self, with_contact: bool) {
        query("UPDATE cloud_chat_conversations SET kind='ai' WHERE legacy_session_id=$1")
            .bind(&self.session)
            .execute(&self.pool)
            .await
            .unwrap();
        if !with_contact {
            query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE conversation_id=$1 AND account_id=$2")
                .bind(self.conversation().await).bind(&self.people[1].account_id).execute(&self.pool).await.unwrap();
        }
    }
    /// The root run's turn identity, computed again for the changed chat.
    async fn fresh_identity(&self) -> Value {
        let (request,): (String,) = query_as(
            "UPDATE cloud_agent_fallback_runs SET turn_identity=NULL WHERE run_id=$1 RETURNING request_message_id",
        )
        .bind(&self.root)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        let owner = &self.people[0].account_id;
        let body = json!({"requestMessageId":request,"sessionId":self.session,"ownerAccountId":owner,"requesterAccountId":owner,"prompt":"Ask Beta and continue","idempotencyKey":request,"claimId":self.claim});
        let claimed = self
            .post(0, "/v1/cloud/agent-runs/desktop/claim", body)
            .await;
        claimed["turnIdentity"].clone()
    }
    /// A send that the server refuses: its status and body.
    async fn refused(&self, arguments: Value) -> (StatusCode, Value) {
        let response = self.router.clone().oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{}/agent-exchange", self.root),
            &self.people[0].token,
            json!({"claimId":self.claim,"toolCallId":uuid::Uuid::new_v4().to_string(),"arguments":arguments}),
        )).await.unwrap();
        let status = response.status();
        (status, read_json(response).await)
    }
}

#[tokio::test]
async fn the_owner_alone_with_their_agent_has_nobody_to_reach() {
    let Some(f) = Fixture::kind(false).await else {
        return;
    };
    f.own_chat(false).await;
    let capabilities = f.capabilities().await;
    assert_eq!(capabilities["available"], false, "{capabilities}");
    assert_eq!(capabilities["people"], json!([]));
    assert_eq!(capabilities["targets"], json!([]));
    let identity = f.fresh_identity().await;
    let note = identity["conversationContext"].as_str().unwrap();
    assert!(!note.contains("reach_out"), "{note}");

    // The production call: the agent asks its owner, who made the request.
    let owner = f.people[0].account_id.clone();
    let (status, body) = f
        .refused(json!({"targetKind":"person","target":owner,"message":"Which Slack channel?"}))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["errorCode"], "context_unavailable");
    assert!(body["message"]
        .as_str()
        .unwrap()
        .contains("ask them in your reply"));
    let asked: (i64,) =
        query_as("SELECT count(*) FROM cloud_agent_exchanges WHERE parent_run_id=$1")
            .bind(&f.root)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(asked.0, 0, "nothing was sent");
}

#[tokio::test]
async fn a_contact_in_the_owners_chat_can_be_asked_but_the_owner_cannot() {
    let Some(f) = Fixture::kind(false).await else {
        return;
    };
    f.own_chat(true).await;
    let capabilities = f.capabilities().await;
    assert_eq!(capabilities["available"], true);
    let people = capabilities["people"].as_array().unwrap();
    assert!(
        people
            .iter()
            .all(|p| p["accountId"] != f.people[0].account_id.as_str()
                && p.get("requester").is_none()),
        "{capabilities}"
    );
    assert!(people
        .iter()
        .any(|p| p["accountId"] == f.people[1].account_id.as_str()));
    let identity = f.fresh_identity().await;
    let note = identity["conversationContext"].as_str().unwrap();
    assert!(
        note.contains("You can reach_out to:")
            && note.contains("ask them in your reply, never with reach_out"),
        "{note}"
    );

    // The owner's id without a kind is not an agent either.
    let owner = f.people[0].account_id.clone();
    let (status, body) = f
        .refused(json!({"target":owner,"message":"Which channel?"}))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(body["message"]
        .as_str()
        .unwrap()
        .contains("ask them in your reply"));
    let (status, body) = f
        .refused(json!({"targetKind":"agent","target":"cloud-agent:nobody","message":"Hi"}))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(body["message"]
        .as_str()
        .unwrap()
        .contains("agent is not reachable"));
    let receipt = f.ask_ok("ask-contact", 1, "Which day works?").await;
    assert_eq!(receipt["targetKind"], "person");

    // A run without a valid lease learns nothing about the directory.
    let response = f.router.clone().oneshot(post_json_with_token(
        &format!("/v1/cloud/agent-runs/desktop/{}/agent-exchange", f.root),
        &f.people[0].token,
        json!({"claimId":uuid::Uuid::new_v4(),"toolCallId":"stale","arguments":{"targetKind":"person","target":owner,"message":"Hi"}}),
    )).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        read_json(response).await["errorCode"],
        "agent_run_not_found"
    );
}
