//! The cloud runner path: a person's request shows its slot as processing as
//! soon as the runner takes it, questions are plain messages that name whom
//! they address by id, and an answering agent may ask its own owner.
use super::*;
use base64::Engine;

impl Fixture {
    async fn macs_offline(&self) {
        std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
        for person in &self.people {
            query("UPDATE cloud_agent_desktop_capabilities SET updated_at=now()-interval '1 hour' WHERE agent_id=$1")
                .bind(format!("cloud-agent:{}", person.account_id)).execute(&self.pool).await.unwrap();
            query("UPDATE cloud_device_presence SET last_heartbeat_at=(now()-interval '1 hour')::text WHERE account_id=$1")
                .bind(&person.account_id).execute(&self.pool).await.unwrap();
        }
    }
    async fn runner_lease(&self, run: &str) -> Value {
        let response = self
            .router
            .clone()
            .oneshot(post_json_with_runner_token(
                "/v1/cloud/agent-runs/lease",
                "runner-test-token",
                json!({"runnerId":"cloud-runner","canaryRunId":run}),
            ))
            .await
            .unwrap();
        let lease = read_json(response).await;
        assert_eq!(lease["run"]["runId"], run, "{lease}");
        lease
    }
    async fn runner_ask(&self, run: &str, key: &str, arguments: Value) -> axum::response::Response {
        self.router
            .clone()
            .oneshot(post_json_with_runner_token(
                &format!("/v1/cloud/agent-runs/{run}/agent-exchange"),
                "runner-test-token",
                json!({"runnerId":"cloud-runner","toolCallId":key,"arguments":arguments}),
            ))
            .await
            .unwrap()
    }
    async fn wire_of(&self, message: &str) -> (Value, i32) {
        let (body, version): (String, i32) = query_as("SELECT content #>> '{blocks,0,text}',version FROM cloud_chat_messages WHERE message_id::text=$1")
            .bind(message).fetch_one(&self.pool).await.unwrap();
        let wire: Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(body.split_once(':').unwrap().1)
                .unwrap(),
        )
        .unwrap();
        (wire.get("message").cloned().unwrap_or(wire), version)
    }
    /// Every version of `message` that its sender's devices received.
    async fn versions(&self, message: &str) -> Vec<Value> {
        fn wires(value: &Value, out: &mut Vec<Value>) {
            match value {
                Value::String(text) => {
                    for prefix in ["kordi-cloud-group:", "kordi-cloud-agent-response:"] {
                        if let Some(encoded) = text.strip_prefix(prefix) {
                            if let Ok(wire) = serde_json::from_slice::<Value>(
                                &base64::engine::general_purpose::URL_SAFE_NO_PAD
                                    .decode(encoded)
                                    .unwrap_or_default(),
                            ) {
                                out.push(wire.get("message").cloned().unwrap_or(wire));
                            }
                        }
                    }
                }
                Value::Array(items) => items.iter().for_each(|item| wires(item, out)),
                Value::Object(map) => map.values().for_each(|item| wires(item, out)),
                _ => {}
            }
        }
        let rows: Vec<(Value,)> = query_as("SELECT e.payload FROM cloud_chat_user_sync_events e JOIN cloud_chat_messages m ON m.message_id=e.entity_id WHERE m.message_id::text=$1 AND e.account_id=m.sender_account_id ORDER BY e.stream_seq")
            .bind(message).fetch_all(&self.pool).await.unwrap();
        let mut out = Vec::new();
        for (payload,) in rows {
            wires(&payload, &mut out);
        }
        assert!(!out.is_empty(), "versions of {message}");
        out
    }
    async fn runner_complete(&self, run: &str, text: &str) {
        let response = self
            .router
            .clone()
            .oneshot(post_json_with_runner_token(
                &format!("/v1/cloud/agent-runs/{run}/complete"),
                "runner-test-token",
                json!({"runnerId":"cloud-runner","responseText":text}),
            ))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "{}",
            read_json(response).await
        );
    }
}

/// No version of a task row is ever finished and empty while the task is open.
fn never_blank(versions: &[Value]) {
    for version in versions {
        assert!(
            !(version["deliveryState"] == "complete"
                && version["text"].as_str().unwrap_or("").is_empty()),
            "a blank finished version: {version}"
        );
    }
}

#[tokio::test]
async fn the_cloud_runner_shows_the_slot_at_once_and_the_question_is_plain_with_a_mention() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    f.macs_offline().await;
    let request = f.group_request(1, "Find a day for a bike ride").await;
    let body = json!({"requestMessageId":request,"sessionId":f.session,"ownerAccountId":f.people[0].account_id,"requesterAccountId":f.people[1].account_id,"prompt":"Find a day","idempotencyKey":format!("bike:{request}")});
    let run = f.post(1, "/v1/cloud/agent-runs/claim", body).await["runId"]
        .as_str()
        .unwrap()
        .to_owned();
    f.runner_lease(&run).await;
    let (slot,): (Option<String>,) =
        query_as("SELECT response_message_id FROM cloud_agent_fallback_runs WHERE run_id=$1")
            .bind(&run)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    let slot = slot.expect("the slot exists before the run finishes");
    assert_eq!(f.wire_of(&slot).await.0["deliveryState"], "processing");

    let asked = f
        .runner_ask(&run, "ask", json!({"target":f.people[1].account_id,"targetKind":"person","message":"Saturday or Sunday?"}))
        .await;
    assert_eq!(asked.status(), StatusCode::OK);
    let exchange = read_json(asked).await["exchangeId"].clone();
    let (question,): (String,) = query_as(
        "SELECT request_message_id::text FROM cloud_agent_exchanges WHERE exchange_id=$1::uuid",
    )
    .bind(exchange.as_str().unwrap())
    .fetch_one(&f.pool)
    .await
    .unwrap();
    let (question, version) = f.wire_of(&question).await;
    assert_eq!(version, 1, "published once, never patched: {question}");
    assert!(
        question["structuredContent"]["agentExchangeStatus"].is_null(),
        "{question}"
    );
    let mention = &question["mentions"][0];
    assert_eq!(mention["humanId"], f.people[1].account_id.as_str());
    assert_eq!(mention["targetKind"], "person");
    let text = question["text"].as_str().unwrap();
    assert!(
        text.starts_with(mention["displayText"].as_str().unwrap()),
        "{text}"
    );
    assert!(
        !text.contains(mention["label"].as_str().unwrap())
            || mention["label"] == mention["displayLabel"],
        "no internal handle: {text}"
    );
    // The task's slot waits for that person, in progress and in words.
    let (waiting, _) = f.wire_of(&slot).await;
    assert_eq!(waiting["deliveryState"], "processing");
    assert!(
        waiting["text"]
            .as_str()
            .unwrap()
            .starts_with("Waiting for "),
        "{waiting}"
    );
}

#[tokio::test]
async fn an_answering_agent_on_the_cloud_runner_asks_its_own_owner() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    f.macs_offline().await;
    let sent = f.send("ask-agent", 1).await;
    let (target,): (String,) =
        query_as("SELECT target_run_id FROM cloud_agent_exchanges WHERE exchange_id=$1::uuid")
            .bind(sent["exchangeId"].as_str().unwrap())
            .fetch_one(&f.pool)
            .await
            .unwrap();
    let (request,): (String,) = query_as(
        "SELECT request_message_id::text FROM cloud_agent_exchanges WHERE exchange_id=$1::uuid",
    )
    .bind(sent["exchangeId"].as_str().unwrap())
    .fetch_one(&f.pool)
    .await
    .unwrap();
    // The request names the agent by id, with the name people know.
    let (wire, _) = f.wire_of(&request).await;
    assert_eq!(
        wire["mentions"][0]["agentId"],
        format!("cloud-agent:{}", f.people[1].account_id)
    );
    assert!(wire["text"]
        .as_str()
        .unwrap()
        .starts_with(wire["mentions"][0]["displayText"].as_str().unwrap()));
    let lease = f.runner_lease(&target).await;
    assert_eq!(lease["run"]["agentCommunication"], true, "{lease}");
    let asked = f
        .runner_ask(&target, "owner", json!({"target":f.people[1].account_id,"targetKind":"person","message":"OK to share Friday?"}))
        .await;
    assert_eq!(asked.status(), StatusCode::OK);
    let other = f
        .runner_ask(
            &target,
            "other",
            json!({"target":f.people[2].account_id,"targetKind":"person","message":"Hi?"}),
        )
        .await;
    assert_ne!(other.status(), StatusCode::OK, "only its own owner");
}

#[tokio::test]
async fn a_cloud_yield_shows_waiting_in_place_and_names_the_agent() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    f.macs_offline().await;
    let request = f.group_request(1, "Find a day for a bike ride").await;
    let body = json!({"requestMessageId":request,"sessionId":f.session,"ownerAccountId":f.people[0].account_id,"requesterAccountId":f.people[1].account_id,"prompt":"Find a day","idempotencyKey":format!("yield:{request}")});
    let run = f.post(1, "/v1/cloud/agent-runs/claim", body).await["runId"]
        .as_str()
        .unwrap()
        .to_owned();
    f.runner_lease(&run).await;
    // The requester's own agent is asked; the slot waits for it by name.
    let agent = format!("cloud-agent:{}", f.people[1].account_id);
    let asked = f
        .runner_ask(
            &run,
            "agent",
            json!({"target":agent,"targetKind":"agent","message":"Saturday or Sunday?"}),
        )
        .await;
    assert_eq!(asked.status(), StatusCode::OK);
    f.runner_complete(&run, r#"{"agentExchangeOutcome":"waiting"}"#)
        .await;
    let (slot,): (String,) =
        query_as("SELECT response_message_id FROM cloud_agent_fallback_runs WHERE run_id=$1")
            .bind(&run)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    let versions = f.versions(&slot).await;
    never_blank(&versions);
    let last = versions.last().unwrap();
    assert_eq!(last["deliveryState"], "processing");
    assert_eq!(
        last["text"], "Waiting for Exchange Beta's Kordi.",
        "{versions:?}"
    );
    assert!(
        last["structuredContent"]["agentExchangeWaitingForAccountId"].is_null(),
        "an agent's wait is nobody's reply"
    );
}

#[tokio::test]
async fn an_answering_slot_waits_for_its_owner_without_a_blank_version() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    f.macs_offline().await;
    let sent = f.send("ask-agent", 1).await;
    let id = sent["exchangeId"].as_str().unwrap().to_owned();
    let (target,): (String,) =
        query_as("SELECT target_run_id FROM cloud_agent_exchanges WHERE exchange_id=$1::uuid")
            .bind(&id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    f.runner_lease(&target).await;
    let asked = f
        .runner_ask(&target, "owner", json!({"target":f.people[1].account_id,"targetKind":"person","message":"OK to share Friday?"}))
        .await;
    assert_eq!(asked.status(), StatusCode::OK);
    f.runner_complete(&target, r#"{"agentExchangeOutcome":"waiting"}"#)
        .await;
    let (reply,): (String,) = query_as(
        "SELECT message_id::text FROM cloud_chat_messages WHERE client_message_id=$1::uuid",
    )
    .bind(&id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    let versions = f.versions(&reply).await;
    never_blank(&versions);
    let last = versions.last().unwrap();
    assert_eq!(last["deliveryState"], "processing");
    assert_eq!(last["text"], "Waiting for Exchange Beta.", "{versions:?}");
}
