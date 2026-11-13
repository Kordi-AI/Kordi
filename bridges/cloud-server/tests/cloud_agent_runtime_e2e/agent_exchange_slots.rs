//! One visible row per agent task (#2416): the asking agent's own slot shows
//! whom it waits for, then processing, then the resumed task's result in
//! place; the question stays a plain message. Only the answering agent, which
//! has no row of its own, gets an added processing row.
use super::*;

impl Fixture {
    /// The root run's own slot, as its executor leaves it when it yields.
    async fn root_slot(&self) -> uuid::Uuid {
        let conversation = self.conversation().await;
        let owner = &self.people[0].account_id;
        let envelope = json!({"kind":"group-message","groupId":self.session,"createdByAccountId":owner,"actor":{"accountId":owner,"displayName":"Alpha"},"participants":[],
            "message":{"id":uuid::Uuid::new_v4(),"senderAccountId":owner,"senderKind":"agent","senderAgentId":format!("cloud-agent:{owner}"),"text":"","createdAtMs":chrono::Utc::now().timestamp_millis(),"deliveryState":"complete","structuredContent":{"synchronizationOnly":true,"agentExchangeOutcome":"waiting"}}});
        let body = format!(
            "kordi-cloud-group:{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(envelope.to_string())
        );
        let id: uuid::Uuid = insert_test_message(&self.pool, owner, conversation, &body)
            .await
            .parse()
            .unwrap();
        query("UPDATE cloud_agent_fallback_runs SET status='completed',completed_at=now()::text,response_message_id=$2 WHERE run_id=$1")
            .bind(&self.root).bind(id.to_string()).execute(&self.pool).await.unwrap();
        id
    }
    async fn message(&self, id: uuid::Uuid) -> Value {
        let (body,): (String,) = query_as(
            "SELECT content #>> '{blocks,0,text}' FROM cloud_chat_messages WHERE message_id=$1",
        )
        .bind(id)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        let wire: Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(body.split_once(':').unwrap().1)
                .unwrap(),
        )
        .unwrap();
        wire.get("message").cloned().unwrap_or(wire)
    }
    async fn agent_rows(&self) -> i64 {
        let (count,): (i64,) = query_as("SELECT count(*) FROM cloud_chat_messages m JOIN cloud_chat_conversations c USING(conversation_id) WHERE c.legacy_session_id=$1 AND m.sender_account_id=$2")
            .bind(&self.session).bind(&self.people[0].account_id).fetch_one(&self.pool).await.unwrap();
        count
    }
}

impl Fixture {
    /// Publishes the root run's group reply from Alpha's Mac, as the desktop
    /// chat publisher does.
    async fn publish_from_mac(&self, id: &str, text: &str, phase: &str) -> Value {
        let (request,): (String,) =
            query_as("SELECT request_message_id FROM cloud_agent_fallback_runs WHERE run_id=$1")
                .bind(&self.root)
                .fetch_one(&self.pool)
                .await
                .unwrap();
        let owner = &self.people[0].account_id;
        let envelope = json!({"kind":"group-message","groupId":self.session,"createdByAccountId":owner,"actor":{"accountId":owner,"displayName":"Alpha"},"participants":[],
            "message":{"id":id,"senderAccountId":owner,"senderKind":"agent","senderAgentId":format!("cloud-agent:{owner}"),"text":text,"createdAtMs":chrono::Utc::now().timestamp_millis(),"deliveryState":phase,"requestId":request,"replyToMessageId":request}});
        let body = format!(
            "kordi-cloud-group:{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(envelope.to_string())
        );
        self.post(
            0,
            &format!("/v1/cloud/agent-runs/desktop/{}/progress", self.root),
            json!({"claimId":self.claim,"body":body,"clientMessageId":uuid::Uuid::new_v4()}),
        )
        .await
    }
    async fn root_response(&self) -> uuid::Uuid {
        let (id,): (String,) =
            query_as("SELECT response_message_id FROM cloud_agent_fallback_runs WHERE run_id=$1")
                .bind(&self.root)
                .fetch_one(&self.pool)
                .await
                .unwrap();
        id.parse().unwrap()
    }
}

/// The owner's Mac runs the task: its processing row is the one slot, also
/// after the turn yields with the waiting outcome, and the resumed result
/// replaces it. A yield that inserted its own row left a second "Waiting
/// for" row behind for every member.
#[tokio::test]
async fn a_mac_run_that_yields_keeps_its_processing_row() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let processing = f
        .publish_from_mac("msg:cloud-agent-processing:slot", "", "processing")
        .await;
    let slot: uuid::Uuid = processing["messageId"].as_str().unwrap().parse().unwrap();
    f.ask_ok("ask", 1, "Which day?").await;
    let rows = f.agent_rows().await;
    let completed = f
        .publish_from_mac(
            "msg:cloud-agent:turn",
            r#"{"agentExchangeOutcome":"waiting"}"#,
            "complete",
        )
        .await;
    assert_eq!(
        completed["messageId"],
        slot.to_string(),
        "the Mac learns the slot"
    );
    assert_eq!(f.agent_rows().await, rows, "no second row for the yield");
    assert_eq!(f.root_response().await, slot);
    let waiting = f.message(slot).await;
    assert_eq!(waiting["id"], "msg:cloud-agent-processing:slot");
    assert_eq!(waiting["text"], "Waiting for Exchange Beta.");
    assert_eq!(waiting["deliveryState"], "processing");
    assert_eq!(
        waiting["structuredContent"]["agentExchangeStatus"],
        "waiting"
    );
    assert_eq!(
        waiting["structuredContent"]["agentExchangeWaitingForAccountId"],
        f.people[1].account_id
    );

    f.say(1, "Tuesday", None).await;
    let resume = f.pending(0).await.remove(0);
    assert_eq!(
        f.message(slot).await["structuredContent"]["agentExchangeStatus"],
        "processing"
    );
    let claim = f.claim(0, &resume).await;
    f.finish(
        0,
        resume["runId"].as_str().unwrap(),
        claim,
        "Booked for Tuesday.",
    )
    .await;
    let done = f.message(slot).await;
    assert_eq!(done["text"], "Booked for Tuesday.");
    assert_eq!(done["deliveryState"], "complete");
    assert!(done["structuredContent"]["agentExchangeStatus"].is_null());
    assert_eq!(
        f.agent_rows().await,
        rows,
        "no processing row is left behind"
    );
}

#[tokio::test]
async fn the_asking_agent_keeps_one_row_from_waiting_to_its_result() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let receipt = f.ask_ok("ask", 1, "Which day?").await;
    let slot = f.root_slot().await;
    f.say(1, "Tuesday", None).await;
    let resume = f.pending(0).await.remove(0);
    let processing = f.message(slot).await;
    assert_eq!(
        processing["structuredContent"]["agentExchangeStatus"],
        "processing"
    );
    assert!(
        processing["structuredContent"]
            .get("synchronizationOnly")
            .is_none(),
        "never emptied"
    );
    let question = f.question_wire(&receipt["exchangeId"]).await;
    assert!(
        question["message"]["structuredContent"]["agentExchangeStatus"].is_null(),
        "the question stays plain"
    );
    let rows = f.agent_rows().await;
    let claim = f.claim(0, &resume).await;
    f.finish(
        0,
        resume["runId"].as_str().unwrap(),
        claim,
        "Booked for Tuesday.",
    )
    .await;
    let done = f.message(slot).await;
    assert_eq!(
        done["text"], "Booked for Tuesday.",
        "the result replaces the slot in place"
    );
    assert_eq!(done["deliveryState"], "complete");
    assert!(done["structuredContent"]["agentExchangeStatus"].is_null());
    assert_eq!(f.agent_rows().await, rows, "no new row for the result");
}

#[tokio::test]
async fn a_silent_failed_or_stopped_task_ends_its_slot_cleanly() {
    for ending in ["silent", "failed", "stopped"] {
        let Some(f) = Fixture::new().await else {
            return;
        };
        f.ask_ok("ask", 1, "Free on Friday?").await;
        let slot = f.root_slot().await;
        f.say(1, "Yes", None).await;
        let resume = f.pending(0).await.remove(0);
        let id = resume["runId"].as_str().unwrap();
        match ending {
            "silent" => {
                let claim = f.claim(0, &resume).await;
                f.finish(0, id, claim, r#"{"agentExchangeOutcome":"silent"}"#)
                    .await;
                let row = f.message(slot).await;
                assert_eq!(
                    row["structuredContent"]["synchronizationOnly"], true,
                    "no empty bubble"
                );
            }
            "failed" => {
                let claim = f.claim(0, &resume).await;
                f.post(
                    0,
                    &format!("/v1/cloud/agent-exchanges/desktop/{id}/fail"),
                    json!({"claimId":claim}),
                )
                .await;
                let row = f.message(slot).await;
                assert_eq!(row["deliveryState"], "failed");
                assert!(row["text"].as_str().unwrap().contains("could not complete"));
            }
            _ => {
                query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE account_id=$1")
                    .bind(&f.people[1].account_id).execute(&f.pool).await.unwrap();
                assert!(f.pending(0).await.is_empty());
                let row = f.message(slot).await;
                assert_eq!(row["deliveryState"], "cancelled");
                assert_eq!(row["text"], "Stopped");
            }
        }
    }
}

#[tokio::test]
async fn an_answering_run_keeps_one_reply_row_through_asking_its_owner() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let exchange = f.send("ask-agent", 1).await["exchangeId"].clone();
    let reply_row = |exchange: &Value| {
        let id: uuid::Uuid = exchange.as_str().unwrap().parse().unwrap();
        let pool = f.pool.clone();
        async move {
            let (message, body): (uuid::Uuid, String) = query_as("SELECT message_id,content #>> '{blocks,0,text}' FROM cloud_chat_messages WHERE client_message_id=$1")
                .bind(id).fetch_one(&pool).await.unwrap();
            let wire: Value = serde_json::from_slice(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(body.split_once(':').unwrap().1)
                    .unwrap(),
            )
            .unwrap();
            (message, wire["message"].clone())
        }
    };
    let (pending_id, pending) = reply_row(&exchange).await;
    assert_eq!(pending["deliveryState"], "processing");
    let target = f.pending(1).await.remove(0);
    let run = target["runId"].as_str().unwrap().to_owned();
    let claim = f.claim(1, &target).await;
    let path = format!("/v1/cloud/agent-runs/desktop/{run}/agent-exchange");
    f.post(1, &path, json!({"claimId":claim,"toolCallId":"owner","arguments":{"target":f.people[1].account_id,"targetKind":"person","message":"OK to share Friday?"}})).await;
    f.finish(1, &run, claim, r#"{"agentExchangeOutcome":"waiting"}"#)
        .await;
    // On the Mac too, the reply row waits for the owner in words, never blank.
    let (_, waiting) = reply_row(&exchange).await;
    assert_eq!(waiting["deliveryState"], "processing");
    assert_eq!(waiting["text"], "Waiting for Exchange Beta.");
    assert!(waiting["structuredContent"]["synchronizationOnly"].is_null());
    f.end_parent().await;
    f.say(1, "Yes, Friday 7pm", None).await;
    let resume = f.pending(1).await.remove(0);
    let (reopened_id, reopened) = reply_row(&exchange).await;
    assert_eq!(reopened_id, pending_id);
    assert_eq!(reopened["deliveryState"], "processing");
    let claim = f.claim(1, &resume).await;
    f.finish(
        1,
        resume["runId"].as_str().unwrap(),
        claim,
        "Beta is free Friday at 7pm.",
    )
    .await;
    let (answered_id, answered) = reply_row(&exchange).await;
    assert_eq!(answered_id, pending_id, "one row from processing to answer");
    assert_eq!(answered["text"], "Beta is free Friday at 7pm.");
}

#[tokio::test]
async fn an_answering_agent_waiting_on_its_owner_never_fails_and_its_question_is_asked_once() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let exchange = f.send("ask-agent", 1).await["exchangeId"].clone();
    let target = f.pending(1).await.remove(0);
    let run = target["runId"].as_str().unwrap().to_owned();
    let claim = f.claim(1, &target).await;
    let path = format!("/v1/cloud/agent-runs/desktop/{run}/agent-exchange");
    f.post(1, &path, json!({"claimId":claim,"toolCallId":"owner","arguments":{"target":f.people[1].account_id,"targetKind":"person","message":"Saturday or Sunday?"}})).await;
    f.finish(1, &run, claim, r#"{"agentExchangeOutcome":"waiting"}"#)
        .await;
    let (status, error): (String, Option<String>) =
        query_as("SELECT status,error_code FROM cloud_agent_fallback_runs WHERE run_id=$1")
            .bind(&run)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(
        (status.as_str(), error),
        ("completed", None),
        "waiting is not a failure"
    );
    assert_eq!(f.exchange(&exchange).await.0, "pending");
    // The asking task also asks the same person: it waits on that question.
    let again = f.ask_ok("again", 1, "Which day works for you?").await;
    let questions: Vec<(Option<uuid::Uuid>,)> = query_as("SELECT DISTINCT request_message_id FROM cloud_agent_exchanges WHERE root_run_id=$1 AND target_kind='person'")
        .bind(&f.root).fetch_all(&f.pool).await.unwrap();
    assert_eq!(questions.len(), 1, "asked once: {questions:?}");
    f.end_parent().await;
    // The cleanup sweep leaves exchange runs to their exchange.
    kordi_cloud_server::cloud_agent_runtime::runs::terminal_backfill::backfill_terminal_responses(
        &f.pool, 15,
    )
    .await
    .unwrap();
    let (failures,): (i64,) = query_as("SELECT count(*) FROM cloud_chat_messages m JOIN cloud_chat_conversations c USING(conversation_id) WHERE c.legacy_session_id=$1 AND m.content::text LIKE '%could not%'")
        .bind(&f.session).fetch_one(&f.pool).await.unwrap();
    assert_eq!(failures, 0, "no failure after a successful yield");
    // One answer resumes both runs.
    f.say(1, "Saturday", None).await;
    assert_eq!(
        f.exchange(&again["exchangeId"]).await.1.as_deref(),
        Some("Saturday")
    );
    assert_eq!(f.pending(1).await.len(), 1, "the answering agent resumes");
}
