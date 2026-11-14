//! One reply row per desktop-run chat request.
//!
//! Every progress snapshot from the Mac carries its own client id. Inserting
//! each one gave a request a new processing message per tick, and a snapshot
//! that arrived late could show the request running after its terminal reply.
//! The run's reply row is now edited in place: progress replaces a processing
//! row, the terminal reply replaces it once, and a terminal row never changes.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::Postgres;
use uuid::Uuid;

use crate::chat_sync::models::{MessageSnapshot, SendMessageRequest};
use crate::chat_sync::store::{
    replace_server_message_in_transaction, send_message_in_transaction, StoreError,
};

const RESPONSE_PREFIX: &str = "kordi-cloud-agent-response:";

/// The delivery state a stored direct agent reply carries.
fn stored_delivery_state(content: &Value) -> Option<String> {
    let encoded = content
        .pointer("/blocks/0/text")
        .and_then(Value::as_str)?
        .strip_prefix(RESPONSE_PREFIX)?;
    let envelope: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
    envelope
        .get("deliveryState")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Publishes `reply` into the run's reply row: the first publication inserts
/// it, later ones edit a processing row in place, and a terminal row stays.
pub(super) async fn publish_into_reply_row(
    transaction: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    run_id: &str,
    sender_account_id: &str,
    conversation_id: Uuid,
    reply: SendMessageRequest,
) -> Result<MessageSnapshot, StoreError> {
    let row: Option<(Uuid, Value)> = query_as(
        "SELECT m.client_message_id, m.content FROM cloud_agent_fallback_runs run \
         JOIN cloud_chat_messages m ON m.message_id::text = run.response_message_id \
         WHERE run.run_id = $1 AND m.sender_account_id = $2 AND m.conversation_id = $3 \
           AND m.deleted_at IS NULL FOR UPDATE OF m",
    )
    .bind(run_id)
    .bind(sender_account_id)
    .bind(conversation_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((row_client_id, content)) = row else {
        return Ok(send_message_in_transaction(
            transaction,
            sender_account_id,
            conversation_id,
            reply,
        )
        .await?
        .value);
    };
    // A retry of the same publication, or a row that already ended, is kept.
    let content = if row_client_id == reply.client_message_id
        || stored_delivery_state(&content).is_some_and(|state| state != "processing")
    {
        content
    } else {
        reply.content
    };
    replace_server_message_in_transaction(
        transaction,
        sender_account_id,
        row_client_id,
        "text",
        content,
    )
    .await?
    .ok_or(StoreError::NotFound)
}

const GROUP_PREFIX: &str = "kordi-cloud-group:";

/// The wire message of a stored or published group envelope.
fn group_message(text: &str) -> Option<Value> {
    let encoded = text.strip_prefix(GROUP_PREFIX)?;
    let mut envelope: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
    Some(envelope.get_mut("message")?.take())
}

/// Whether a group run's completion is a yield: the task waits for someone,
/// or carries the waiting outcome when no open question names whom.
pub(super) fn is_group_yield(body: &str) -> bool {
    group_message(body).is_some_and(|message| {
        let meta = &message["structuredContent"];
        meta["agentExchangeStatus"].is_string() || meta["agentExchangeOutcome"] == "waiting"
    })
}

/// A group run keeps one visible row from processing to its end (#2416). The
/// processing row the run published first is its reply slot:
/// - a yield leaves it in place, and the server shows whom the task waits for
///   in it until the resumed result replaces it;
/// - a reply, failure or stop replaces it in place, under the slot's message
///   id and timeline position, so no client shows the row vanish before the
///   reply appears.
///
/// Returns `None` when the run has no slot still in progress, so the caller
/// inserts the publication as before.
pub(super) async fn publish_into_group_slot(
    transaction: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    run_id: &str,
    sender_account_id: &str,
    conversation_id: Uuid,
    body: &str,
) -> Result<Option<MessageSnapshot>, StoreError> {
    let row: Option<(Uuid, Value)> = query_as(
        "SELECT m.client_message_id, m.content FROM cloud_agent_fallback_runs run \
         JOIN cloud_chat_messages m ON m.message_id::text = run.response_message_id \
         WHERE run.run_id = $1 AND m.sender_account_id = $2 AND m.conversation_id = $3 \
           AND m.deleted_at IS NULL FOR UPDATE OF m",
    )
    .bind(run_id)
    .bind(sender_account_id)
    .bind(conversation_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((row_client_id, content)) = row else {
        return Ok(None);
    };
    if !slot_in_progress(&content) {
        // A retry of the reply that ended the slot changes nothing; anything
        // else is a publication of its own.
        let retried =
            !is_group_yield(body) && reply_in_slot(&content, body).as_ref() == Some(&content);
        if !retried {
            return Ok(None);
        }
    }
    // A yield leaves the slot as it is: replacing it with its own content changes nothing.
    let content = if is_group_yield(body) || !slot_in_progress(&content) {
        content
    } else {
        match reply_in_slot(&content, body) {
            Some(content) => content,
            None => return Ok(None),
        }
    };
    replace_server_message_in_transaction(
        transaction,
        sender_account_id,
        row_client_id,
        "text",
        content,
    )
    .await
}

/// What the slot keeps when a reply takes its place: its id and timeline
/// position, and the sender identity the server stored for it.
const SLOT_KEYS: [&str; 8] = [
    "id",
    "createdAtMs",
    "senderAccountId",
    "senderKind",
    "senderAgentId",
    "senderOwnerAccountId",
    "senderOwnerName",
    "senderDisplayName",
];

/// The stored content of `slot` with the published reply `body` in its place.
fn reply_in_slot(slot: &Value, body: &str) -> Option<Value> {
    let encoded = slot
        .pointer("/blocks/0/text")
        .and_then(Value::as_str)?
        .strip_prefix(GROUP_PREFIX)?;
    let mut envelope: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
    let reply = group_message(body)?;
    let message = envelope.get_mut("message")?.as_object_mut()?;
    for (key, value) in reply.as_object()? {
        if !SLOT_KEYS.contains(&key.as_str()) {
            message.insert(key.clone(), value.clone());
        }
    }
    let text = format!(
        "{GROUP_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(envelope.to_string())
    );
    let mut content = slot.clone();
    content["blocks"][0]["text"] = Value::String(text);
    Some(content)
}

fn slot_in_progress(content: &Value) -> bool {
    content
        .pointer("/blocks/0/text")
        .and_then(Value::as_str)
        .and_then(group_message)
        .is_some_and(|message| message["deliveryState"] == "processing")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stored(envelope: Value) -> Value {
        let text = format!(
            "{RESPONSE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(envelope.to_string())
        );
        json!({"schema": 1, "blocks": [{"type": "text", "text": text}]})
    }

    fn group_body(message: Value) -> String {
        let envelope = json!({"kind": "group-message", "groupId": "g", "message": message});
        format!(
            "{GROUP_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(envelope.to_string())
        )
    }

    #[test]
    fn a_waiting_group_completion_is_a_yield() {
        let waiting = group_body(
            json!({"deliveryState": "processing", "text": "Waiting for Alex.",
            "structuredContent": {"agentExchangeStatus": "waiting", "agentExchangeWaitingFor": "Alex"}}),
        );
        let unnamed = group_body(json!({"deliveryState": "complete", "text": "",
            "structuredContent": {"synchronizationOnly": true, "agentExchangeOutcome": "waiting"}}));
        let silent = group_body(json!({"deliveryState": "complete", "text": "",
            "structuredContent": {"synchronizationOnly": true, "agentExchangeOutcome": "silent"}}));
        let answer = group_body(
            json!({"deliveryState": "complete", "text": "Done.", "structuredContent": null}),
        );
        assert!(is_group_yield(&waiting));
        assert!(is_group_yield(&unnamed));
        assert!(!is_group_yield(&silent));
        assert!(!is_group_yield(&answer));
        assert!(!is_group_yield("kordi-cloud-agent-response:e30"));
    }

    #[test]
    fn only_a_slot_still_in_progress_takes_the_yield() {
        let stored = |state: &str| {
            json!({"schema": 1, "blocks": [{"type": "text",
                "text": group_body(json!({"id": "slot", "deliveryState": state, "text": ""}))}]})
        };
        assert!(slot_in_progress(&stored("processing")));
        assert!(!slot_in_progress(&stored("complete")));
        assert!(!slot_in_progress(&stored("cancelled")));
    }

    #[test]
    fn a_reply_takes_the_slots_id_and_place() {
        let slot = json!({"schema": 1, "blocks": [{"type": "text", "text": group_body(
            json!({"id": "slot", "createdAtMs": 10, "deliveryState": "processing", "text": "",
                "senderOwnerName": "Stored Owner"}))}]});
        let reply = group_body(
            json!({"id": "reply", "createdAtMs": 99, "deliveryState": "complete",
            "text": "Done.", "structuredContent": {"tools": []}}),
        );
        let replaced = reply_in_slot(&slot, &reply).unwrap();
        let message = group_message(replaced["blocks"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(message["id"], "slot");
        assert_eq!(message["createdAtMs"], 10);
        assert_eq!(message["text"], "Done.");
        assert_eq!(message["deliveryState"], "complete");
        assert_eq!(message["structuredContent"]["tools"], json!([]));
        assert_eq!(
            message["senderOwnerName"], "Stored Owner",
            "the stored identity stays"
        );
        assert!(reply_in_slot(&slot, "kordi-cloud-agent-response:e30").is_none());
    }

    #[test]
    fn reads_the_delivery_state_of_a_stored_reply() {
        let processing = stored(json!({"kind": "agent-response", "deliveryState": "processing"}));
        let cancelled = stored(json!({"kind": "agent-response", "deliveryState": "cancelled"}));
        assert_eq!(
            stored_delivery_state(&processing).as_deref(),
            Some("processing")
        );
        assert_eq!(
            stored_delivery_state(&cancelled).as_deref(),
            Some("cancelled")
        );
        assert_eq!(
            stored_delivery_state(&json!({"blocks": [{"text": "plain"}]})),
            None
        );
    }
}
