//! Runs started by an exchange, not a fresh mention, show a processing row
//! at once that becomes their answer in place, or ends cleanly.
use super::*;

/// A slot row: its message id, what it replies to, and its wire message.
struct Slot {
    id: uuid::Uuid,
    reply_to: Option<uuid::Uuid>,
    message: Value,
}

impl Fixture {
    async fn slot(&self, exchange: &Value, continued: bool) -> Option<Slot> {
        let exchange: uuid::Uuid = exchange.as_str().unwrap().parse().unwrap();
        let client = if continued {
            uuid::Uuid::new_v5(&exchange, b"continued")
        } else {
            exchange
        };
        let row: Option<(uuid::Uuid, Option<uuid::Uuid>, String)> = query_as("SELECT message_id,reply_to_message_id,content #>> '{blocks,0,text}' FROM cloud_chat_messages WHERE client_message_id=$1 AND deleted_at IS NULL")
            .bind(client).fetch_optional(&self.pool).await.unwrap();
        row.map(|(id, reply_to, body)| {
            let wire: Value = serde_json::from_slice(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(body.split_once(':').unwrap().1)
                    .unwrap(),
            )
            .unwrap();
            Slot {
                id,
                reply_to,
                message: wire["message"].clone(),
            }
        })
    }
    async fn fail(&self, person: usize, run: &str, claim: uuid::Uuid) {
        self.post(
            person,
            &format!("/v1/cloud/agent-exchanges/desktop/{run}/fail"),
            json!({"claimId":claim}),
        )
        .await;
    }
}

#[tokio::test]
async fn a_resume_after_a_person_answer_shows_processing_then_its_answer_in_place() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let receipt = f.ask_ok("ask", 1, "Which day?").await;
    f.end_parent().await;
    assert!(
        f.slot(&receipt["exchangeId"], true).await.is_none(),
        "nothing runs yet"
    );
    let answer = f.say(1, "Tuesday", None).await;
    let resume = f.pending(0).await.remove(0);
    let processing = f
        .slot(&receipt["exchangeId"], true)
        .await
        .expect("processing row");
    assert_eq!(processing.message["deliveryState"], "processing");
    assert_eq!(processing.message["text"], "");
    assert_eq!(
        processing.reply_to,
        Some(answer),
        "it replies to the person's answer"
    );
    let claim = f.claim(0, &resume).await;
    f.finish(
        0,
        resume["runId"].as_str().unwrap(),
        claim,
        "Booked for Tuesday.",
    )
    .await;
    let done = f.slot(&receipt["exchangeId"], true).await.unwrap();
    assert_eq!(
        done.id, processing.id,
        "the answer replaces the row in place"
    );
    assert_eq!(done.message["deliveryState"], "complete");
    assert_eq!(done.message["text"], "Booked for Tuesday.");
}

#[tokio::test]
async fn a_silent_or_failed_resume_never_leaves_a_spinner() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let first = f.ask_ok("first", 1, "Free on Friday?").await;
    let second = f.ask_ok("second", 2, "Free on Friday?").await;
    f.end_parent().await;
    f.say(1, "Yes", None).await;
    f.say(2, "No", None).await;
    let runs = f.pending(0).await;
    assert_eq!(runs.len(), 2);
    for run in &runs {
        let id = run["runId"].as_str().unwrap();
        let claim = f.claim(0, run).await;
        if data(run)["sentQuestion"] == "Free on Friday?" && data(run)["personReply"] == "Yes" {
            f.finish(0, id, claim, r#"{"agentExchangeOutcome":"silent"}"#)
                .await;
        } else {
            f.fail(0, id, claim).await;
        }
    }
    let silent = f.slot(&first["exchangeId"], true).await.unwrap();
    assert_eq!(silent.message["deliveryState"], "complete");
    assert_eq!(silent.message["text"], "");
    assert_eq!(
        silent.message["structuredContent"]["synchronizationOnly"],
        true
    );
    let failed = f.slot(&second["exchangeId"], true).await.unwrap();
    assert_eq!(failed.message["deliveryState"], "failed");
    assert!(failed.message["text"]
        .as_str()
        .unwrap()
        .contains("could not complete"));
}

#[tokio::test]
async fn a_cancelled_resume_shows_stopped() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let receipt = f.ask_ok("ask", 1, "Which day?").await;
    f.end_parent().await;
    f.say(1, "Tuesday", None).await;
    assert_eq!(f.pending(0).await.len(), 1, "the resume run exists");
    assert_eq!(
        f.slot(&receipt["exchangeId"], true).await.unwrap().message["deliveryState"],
        "processing"
    );
    query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE account_id=$1")
        .bind(&f.people[1].account_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(f.pending(0).await.is_empty());
    let stopped = f.slot(&receipt["exchangeId"], true).await.unwrap();
    assert_eq!(stopped.message["deliveryState"], "cancelled");
    assert_eq!(stopped.message["text"], "Stopped");
}

#[tokio::test]
async fn an_answering_run_keeps_one_reply_row_through_asking_its_owner() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let exchange = f.send("ask-agent", 1).await["exchangeId"].clone();
    let pending = f
        .slot(&exchange, false)
        .await
        .expect("the answering agent's row");
    assert_eq!(pending.message["deliveryState"], "processing");
    let target = f.pending(1).await.remove(0);
    let run = target["runId"].as_str().unwrap().to_owned();
    let claim = f.claim(1, &target).await;
    let path = format!("/v1/cloud/agent-runs/desktop/{run}/agent-exchange");
    f.post(1, &path, json!({"claimId":claim,"toolCallId":"owner","arguments":{"target":f.people[1].account_id,"targetKind":"person","message":"OK to share Friday?"}})).await;
    f.finish(1, &run, claim, r#"{"agentExchangeOutcome":"waiting"}"#)
        .await;
    let waiting = f.slot(&exchange, false).await.unwrap();
    assert_eq!(
        waiting.message["structuredContent"]["synchronizationOnly"], true,
        "no spinner while the owner decides"
    );
    f.end_parent().await;
    f.say(1, "Yes, Friday 7pm", None).await;
    let resume = f.pending(1).await.remove(0);
    let reopened = f.slot(&exchange, false).await.unwrap();
    assert_eq!(reopened.id, pending.id);
    assert_eq!(reopened.message["deliveryState"], "processing");
    let claim = f.claim(1, &resume).await;
    f.finish(
        1,
        resume["runId"].as_str().unwrap(),
        claim,
        "Beta is free Friday at 7pm.",
    )
    .await;
    let answered = f.slot(&exchange, false).await.unwrap();
    assert_eq!(answered.id, pending.id, "one row from processing to answer");
    assert_eq!(answered.message["text"], "Beta is free Friday at 7pm.");
    assert!(
        f.slot(&exchange, true).await.is_none(),
        "no extra continuation row on the answering side"
    );
}
