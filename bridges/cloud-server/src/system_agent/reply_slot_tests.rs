//! The Facilitator's reply row against a real database: shown as soon as a
//! run takes a direct request, then the reply in that same row; a failure
//! shows the failed line until the retry takes the row back.

use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::super::ownership_sweep_tests::{group, say, Chat};

impl Chat {
    /// Bob asks the Facilitator directly; returns the request's group id.
    /// The Facilitator's agent carries its name, as startup sets it up.
    async fn ask_facilitator(&self) -> String {
        let named = query(
            "UPDATE cloud_default_agent_profiles SET display_name = 'Facilitator'
             WHERE owner_account_id = $1",
        )
        .bind(&self.config.account_id)
        .execute(&self.pool)
        .await
        .unwrap();
        assert_eq!(named.rows_affected(), 1);
        let id = Uuid::new_v4().to_string();
        let ask = group(
            self.chat,
            json!({"id": id, "senderAccountId": self.bob, "createdAtMs": 1, "text": "@Facilitator hi",
                "mentions": [{"label": "Facilitator", "targetKind": "agent",
                    "targetIdentityId": format!("agent:cloud-agent:{}", self.config.account_id),
                    "startUtf16": 0, "lengthUtf16": 12, "displayText": "@Facilitator"}]}),
        );
        say(&self.pool, &self.bob, self.chat, &ask).await;
        id
    }

    /// The Facilitator's rows in the chat: (message id, version, envelope message).
    async fn facilitator_rows(&self) -> Vec<(String, i32, Value)> {
        let rows: Vec<(String, i32, Value)> = query_as(
            "SELECT message_id::text, version, content FROM cloud_chat_messages
             WHERE conversation_id = $1 AND sender_account_id = $2 AND deleted_at IS NULL
             ORDER BY conversation_sequence",
        )
        .bind(self.chat)
        .bind(&self.config.account_id)
        .fetch_all(&self.pool)
        .await
        .unwrap();
        rows.into_iter()
            .map(|(id, version, content)| {
                let text = content["blocks"][0]["text"].as_str().unwrap_or_default();
                let envelope = super::super::input::cloud_envelope(text).unwrap_or(Value::Null);
                (id, version, envelope["message"].clone())
            })
            .collect()
    }

    async fn active_run(&self) -> String {
        let (run_id,): (String,) = query_as(
            "SELECT active_run_id FROM cloud_pip_conversation_state WHERE conversation_id = $1",
        )
        .bind(self.chat)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        run_id
    }
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn a_direct_request_shows_a_working_row_that_becomes_the_reply() {
    let chat = Chat::new().await;
    let request = chat.ask_facilitator().await;
    assert_eq!(chat.sweep().await, 1);

    let rows = chat.facilitator_rows().await;
    assert_eq!(rows.len(), 1, "one working row: {rows:?}");
    let (row_id, version, working) = &rows[0];
    assert_eq!(working["senderKind"], "agent");
    assert_eq!(working["senderDisplayName"], "Facilitator");
    assert_eq!(working["deliveryState"], "processing");
    assert_eq!(working["requestId"], json!(request));
    assert_eq!(working["text"], "");
    let (response,): (Option<String>,) =
        query_as("SELECT response_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(chat.active_run().await)
            .fetch_one(&chat.pool)
            .await
            .unwrap();
    assert_eq!(
        response.as_ref(),
        Some(row_id),
        "the row is the run's reply"
    );

    let posted = chat.finish_run(Some("Hi Bob! I can find a time.")).await;
    assert_eq!(posted["message"]["text"], "Hi Bob! I can find a time.");
    let rows = chat.facilitator_rows().await;
    assert_eq!(rows.len(), 1, "the reply took the row in place");
    let (id, new_version, reply) = &rows[0];
    assert_eq!(id, row_id);
    assert!(new_version > version);
    assert_eq!(reply["deliveryState"], "complete");
    assert_eq!(reply["requestId"], json!(request));
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn a_failed_request_shows_the_failure_until_its_retry_takes_the_row_back() {
    let chat = Chat::new().await;
    chat.ask_facilitator().await;
    assert_eq!(chat.sweep().await, 1);
    let run_id = chat.active_run().await;
    super::super::retry::fail(&chat.pool, &run_id, None, "provider_error")
        .await
        .unwrap();
    let rows = chat.facilitator_rows().await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].2["deliveryState"], "failed");
    assert_eq!(rows[0].2["text"], "Facilitator couldn't reply.");

    // The backoff passes; the retry takes the same row back.
    query("UPDATE cloud_pip_conversation_state SET retry_after = now() WHERE conversation_id = $1")
        .bind(chat.chat)
        .execute(&chat.pool)
        .await
        .unwrap();
    assert_eq!(chat.sweep().await, 1, "the request is retried");
    let retried = chat.facilitator_rows().await;
    assert_eq!(retried.len(), 1, "still one row: {retried:?}");
    assert_eq!(retried[0].0, rows[0].0);
    assert_eq!(retried[0].2["deliveryState"], "processing");
}
