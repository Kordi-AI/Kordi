//! An agent asks a person in its conversation and continues on their answer.
use super::*;
use base64::Engine;
use sqlx_core::query_as::query_as;

impl Fixture {
    async fn ask(&self, key: &str, person: usize, question: &str) -> axum::response::Response {
        self.router.clone().oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{}/agent-exchange", self.root),
            &self.people[0].token,
            json!({"claimId":self.claim,"toolCallId":key,"arguments":{"target":self.people[person].account_id,"targetKind":"person","message":question}}),
        )).await.unwrap()
    }
    async fn ask_ok(&self, key: &str, person: usize, question: &str) -> Value {
        let response = self.ask(key, person, question).await;
        let status = response.status();
        let body = read_json(response).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }
    async fn conversation(&self) -> uuid::Uuid {
        query_as::<_, (uuid::Uuid,)>(
            "SELECT conversation_id FROM cloud_chat_conversations WHERE legacy_session_id=$1",
        )
        .bind(&self.session)
        .fetch_one(&self.pool)
        .await
        .unwrap()
        .0
    }
    /// Sends through the chat API, as a signed-in Mac or iPhone does.
    async fn say(&self, person: usize, text: &str, reply_to: Option<uuid::Uuid>) -> uuid::Uuid {
        let conversation = self.conversation().await;
        let body = json!({"client_message_id":uuid::Uuid::now_v7(),"kind":"text","content":{"schema":1,"blocks":[{"type":"text","text":text}]},"reply_to_message_id":reply_to});
        let response = self
            .router
            .clone()
            .oneshot(post_json_with_token(
                &format!("/v2/chat/conversations/{conversation}/messages"),
                &self.people[person].token,
                body,
            ))
            .await
            .unwrap();
        assert!(response.status().is_success(), "{}", response.status());
        read_json(response).await["message"]["id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap()
    }
    async fn exchange(&self, id: &Value) -> (String, Option<String>, Option<uuid::Uuid>) {
        query_as("SELECT status,response_text,request_message_id FROM cloud_agent_exchanges WHERE exchange_id=$1::uuid")
            .bind(id.as_str().unwrap()).fetch_one(&self.pool).await.unwrap()
    }
    async fn question_wire(&self, id: &Value) -> Value {
        let (body,): (String,) = query_as("SELECT m.content #>> '{blocks,0,text}' FROM cloud_agent_exchanges e JOIN cloud_chat_messages m ON m.message_id=e.request_message_id WHERE e.exchange_id=$1::uuid")
            .bind(id.as_str().unwrap()).fetch_one(&self.pool).await.unwrap();
        serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(body.split_once(':').unwrap().1)
                .unwrap(),
        )
        .unwrap()
    }
}

fn data(run: &Value) -> Value {
    let prompt = run["prompt"].as_str().unwrap();
    serde_json::from_str(prompt.split_once('\n').unwrap().1).unwrap()
}

#[tokio::test]
async fn a_person_answer_resumes_the_asking_agent() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let capabilities = f
        .post(
            0,
            &format!("/v1/cloud/agent-runs/desktop/{}/agent-exchange", f.root),
            json!({"claimId":f.claim,"action":"capabilities"}),
        )
        .await;
    let people: Vec<&str> = capabilities["people"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["accountId"].as_str().unwrap())
        .collect();
    assert!(people.contains(&f.people[1].account_id.as_str()));
    assert!(
        !people.contains(&f.people[0].account_id.as_str()),
        "the owner is not a target"
    );
    let owner = f.ask("self", 0, "Are you sure?").await;
    assert_ne!(owner.status(), StatusCode::OK);

    let early = f.say(1, "Said before the question", None).await;
    let receipt = f.ask_ok("ask-beta", 1, "Which day works?").await;
    assert_eq!(receipt["targetKind"], "person");
    assert_eq!(receipt["status"], "pending");
    assert!(receipt["message"]
        .as_str()
        .unwrap()
        .contains(r#"{"agentExchangeOutcome":"waiting"}"#));
    assert_eq!(
        f.ask_ok("ask-beta", 1, "Which day works?").await["exchangeId"],
        receipt["exchangeId"],
        "a retried call does not ask twice"
    );
    let wire = f.question_wire(&receipt["exchangeId"]).await;
    let metadata = &wire["message"]["structuredContent"];
    assert_eq!(metadata["agentExchangeStatus"], "waiting");
    assert_eq!(metadata["agentExchangeWaitingFor"], "Exchange Beta");
    assert!(wire["message"]["text"]
        .as_str()
        .unwrap()
        .starts_with("@ExchangeBeta Which day works?"));
    assert!(f.pending(1).await.is_empty(), "nothing runs for the person");
    f.end_parent().await;

    // Another member, and the person's own agent, do not answer.
    f.say(2, "Gamma speaking", None).await;
    let conversation = f.conversation().await;
    let agent = json!({"kind":"group-message","groupId":f.session,"createdByAccountId":f.people[0].account_id,"actor":{"accountId":f.people[1].account_id,"displayName":"Synthetic"},"participants":[],
        "message":{"id":uuid::Uuid::new_v4(),"senderAccountId":f.people[1].account_id,"senderKind":"agent","text":"Agent speaking","createdAtMs":chrono::Utc::now().timestamp_millis()}});
    insert_test_message(
        &f.pool,
        &f.people[1].account_id,
        conversation,
        &format!(
            "kordi-cloud-group:{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(agent.to_string())
        ),
    )
    .await;
    assert!(f.pending(0).await.is_empty());
    assert_eq!(f.exchange(&receipt["exchangeId"]).await.0, "pending");

    let answer = f.say(1, "Tuesday works", None).await;
    assert_ne!(answer, early);
    let (status, text, _) = f.exchange(&receipt["exchangeId"]).await;
    assert_eq!(status, "reply_received");
    assert_eq!(text.as_deref(), Some("Tuesday works"));
    let resume = f.pending(0).await.remove(0);
    let resumed = data(&resume);
    assert_eq!(resumed["personReplied"], true);
    assert_eq!(resumed["personReply"], "Tuesday works");
    assert_eq!(resumed["person"], "Exchange Beta");
    assert_eq!(resumed["remainingRequests"], 7);
    let claim = f.claim(0, &resume).await;
    f.finish(
        0,
        resume["runId"].as_str().unwrap(),
        claim,
        r#"{"agentExchangeOutcome":"silent"}"#,
    )
    .await;
    assert_eq!(f.exchange(&receipt["exchangeId"]).await.0, "completed");
}

#[tokio::test]
async fn a_quote_reply_answers_its_own_question_first() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let first = f.ask_ok("first", 1, "First question?").await;
    let second = f.ask_ok("second", 1, "Second question?").await;
    f.end_parent().await;
    let (_, _, second_message) = f.exchange(&second["exchangeId"]).await;
    f.say(1, "Answer to the second", second_message).await;
    assert_eq!(
        f.exchange(&second["exchangeId"]).await.1.as_deref(),
        Some("Answer to the second")
    );
    assert_eq!(f.exchange(&first["exchangeId"]).await.0, "pending");
    f.say(1, "Answer to the first", None).await;
    assert_eq!(
        f.exchange(&first["exchangeId"]).await.1.as_deref(),
        Some("Answer to the first")
    );
}

#[tokio::test]
async fn an_unanswered_person_question_times_out_and_leaving_cancels() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let receipt = f.ask_ok("gamma", 2, "Are you joining?").await;
    let (deadline,): (bool,) = query_as("SELECT deadline_at>now()+interval '23 hours' FROM cloud_agent_exchanges WHERE exchange_id=$1::uuid")
        .bind(receipt["exchangeId"].as_str().unwrap()).fetch_one(&f.pool).await.unwrap();
    assert!(deadline, "people get a long deadline");
    f.end_parent().await;
    query("UPDATE cloud_agent_exchanges SET deadline_at=now()-interval '1 second' WHERE parent_run_id=$1").bind(&f.root).execute(&f.pool).await.unwrap();
    let resume = f.pending(0).await.remove(0);
    let resumed = data(&resume);
    assert_eq!(resumed["personReplied"], false);
    assert!(resumed["personReply"]
        .as_str()
        .unwrap()
        .contains("did not answer"));
    f.say(2, "Too late", None).await;
    assert!(f
        .exchange(&receipt["exchangeId"])
        .await
        .1
        .unwrap()
        .contains("did not answer"));

    let Some(f) = Fixture::new().await else {
        return;
    };
    let receipt = f.ask_ok("beta", 1, "Still there?").await;
    query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE account_id=$1")
        .bind(&f.people[1].account_id)
        .execute(&f.pool)
        .await
        .unwrap();
    f.end_parent().await;
    assert!(f.pending(0).await.is_empty());
    assert_eq!(f.exchange(&receipt["exchangeId"]).await.0, "cancelled");
}
