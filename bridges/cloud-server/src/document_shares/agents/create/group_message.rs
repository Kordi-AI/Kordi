//! The document message: documents no reply took, or a background session's
//! documents, posted in their group as the agent's own message, with the same
//! identity as the agent's replies (`senderKind: "agent"` and the agent's id,
//! sent by its owner's account).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::reply::{attachment_reference, RunDocument};
use crate::chat_sync::models::SendMessageRequest;
use crate::chat_sync::store::{self, StoreError};

const GROUP_PREFIX: &str = "kordi-cloud-group:";
/// Recent messages searched for the group's participant list.
const ENVELOPE_SCAN: i64 = 200;

pub(super) struct DocumentMessage<'a> {
    pub conversation_id: Uuid,
    /// One short line naming the request the documents belong to.
    pub text: &'a str,
    pub run_id: &'a str,
    pub session_id: &'a str,
    pub owner_account_id: &'a str,
    pub agent_id: &'a str,
    pub documents: &'a [RunDocument],
}

impl DocumentMessage<'_> {
    /// Stable per run and document set, so a repeated sweep finds its message.
    fn client_message_id(&self) -> Uuid {
        let ids: Vec<&str> = self
            .documents
            .iter()
            .map(|document| document.attachment_id.as_str())
            .collect();
        let digest = Sha256::digest(format!(
            "kordi-agent-document-message\0{}\0{}",
            self.run_id,
            ids.join("\0")
        ));
        let mut bytes = [0u8; 16];
        bytes.copy_from_slice(&digest[..16]);
        bytes[6] = (bytes[6] & 0x0f) | 0x50;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        Uuid::from_bytes(bytes)
    }
}

fn decoded_group_message(content: &Value) -> Option<Value> {
    let body = crate::chat_sync::voice::body_for_agent(content);
    let encoded = body.trim().strip_prefix(GROUP_PREFIX)?;
    let envelope: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
    let participants = envelope.get("participants")?.as_array()?;
    (envelope.get("kind").and_then(Value::as_str) == Some("group-message")
        && !participants.is_empty())
    .then_some(envelope)
}

/// The newest group message envelope of the conversation, for its
/// participants and group identity.
async fn latest_envelope(
    pool: &PgPool,
    conversation_id: Uuid,
) -> Result<Option<Value>, sqlx_core::Error> {
    let rows: Vec<(Value,)> = query_as(
        "SELECT content FROM cloud_chat_messages \
         WHERE conversation_id = $1 AND deleted_at IS NULL \
         ORDER BY conversation_sequence DESC LIMIT $2",
    )
    .bind(conversation_id)
    .bind(ENVELOPE_SCAN)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .find_map(|(content,)| decoded_group_message(content)))
}

/// Recent messages searched for the request a document belongs to.
const REQUEST_SCAN: i64 = 1000;
/// Longest quote of the request, in characters.
const REQUEST_QUOTE_CHARS: usize = 80;

/// One line that names the request `run_id` answered, quoting it, such as
/// `For Alex's request: "Do a literature review"`. The message answers no
/// request itself, so without this line nothing would say what it is for.
/// `None` when the request is no longer in the group.
pub(super) async fn request_line(
    pool: &PgPool,
    conversation_id: Uuid,
    run_id: &str,
) -> Result<Option<String>, sqlx_core::Error> {
    let run: Option<(String,)> =
        query_as("SELECT request_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(run_id)
            .fetch_optional(pool)
            .await?;
    let Some((request_id,)) = run else {
        return Ok(None);
    };
    let rows: Vec<(Uuid, Value)> = query_as(
        "SELECT message_id, content FROM cloud_chat_messages \
         WHERE conversation_id = $1 AND deleted_at IS NULL \
         ORDER BY conversation_sequence DESC LIMIT $2",
    )
    .bind(conversation_id)
    .bind(REQUEST_SCAN)
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().find_map(|(message_id, content)| {
        let envelope = decoded_group_message(content)?;
        let request = &envelope["message"];
        let matches = message_id.to_string() == request_id
            || request["id"].as_str() == Some(request_id.as_str());
        if !matches || request["senderKind"] == "agent" {
            return None;
        }
        let text = request["text"]
            .as_str()?
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if text.is_empty() {
            return None;
        }
        let quote: String = text.chars().take(REQUEST_QUOTE_CHARS).collect();
        let quote = if quote.len() < text.len() {
            format!("{quote}…")
        } else {
            quote
        };
        let name = envelope["actor"]["displayName"]
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty());
        Some(match name {
            Some(name) => format!("For {name}'s request: “{quote}”"),
            None => format!("For the request: “{quote}”"),
        })
    }))
}

/// The group envelope of the fallback message. It answers no request, so
/// clients never take it for the run's reply.
pub(super) fn document_envelope(
    latest: &Value,
    message: &DocumentMessage<'_>,
    created_at_ms: i64,
) -> Value {
    let participants = latest
        .get("participants")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let actor = participants
        .as_array()
        .and_then(|all| {
            all.iter().find(|participant| {
                participant.get("accountId").and_then(Value::as_str)
                    == Some(message.owner_account_id)
            })
        })
        .cloned()
        .unwrap_or_else(|| {
            json!({ "accountId": message.owner_account_id, "displayName": "Kordi", "role": "person" })
        });
    let mut envelope = Map::new();
    envelope.insert("kind".into(), json!("group-message"));
    envelope.insert("groupId".into(), json!(message.session_id));
    for key in ["groupSpaceId", "createdByAccountId"] {
        if let Some(value) = latest.get(key).filter(|value| !value.is_null()) {
            envelope.insert(key.into(), value.clone());
        }
    }
    envelope.insert("groupTitle".into(), Value::Null);
    envelope.insert("actor".into(), actor);
    envelope.insert("participants".into(), participants);
    let references: Vec<Value> = message.documents.iter().map(attachment_reference).collect();
    envelope.insert(
        "message".into(),
        json!({
            "id": format!("msg:cloud-agent-document:{}", message.client_message_id()),
            "senderAccountId": message.owner_account_id,
            "senderAgentId": message.agent_id,
            "senderKind": "agent",
            "text": message.text,
            "createdAtMs": created_at_ms,
            "deliveryState": "complete",
            "attachments": references,
        }),
    );
    Value::Object(envelope)
}

/// Sends the fallback message as the agent; `None` when the group has no
/// envelope to address it with or the store refused it for good.
pub(super) async fn post(
    pool: &PgPool,
    message: DocumentMessage<'_>,
) -> Result<Option<String>, sqlx_core::Error> {
    let Some(latest) = latest_envelope(pool, message.conversation_id).await? else {
        return Ok(None);
    };
    let envelope = document_envelope(&latest, &message, chrono::Utc::now().timestamp_millis());
    let body = format!(
        "{GROUP_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap_or_default())
    );
    let references: Vec<Value> = message.documents.iter().map(attachment_reference).collect();
    let client_message_id = message.client_message_id();
    let sent = store::send_message(
        pool,
        message.owner_account_id,
        message.conversation_id,
        SendMessageRequest {
            client_message_id,
            kind: "text".to_string(),
            content: json!({
                "schema": 1,
                "blocks": [{ "type": "text", "text": body }],
                "legacy_attachments": references,
            }),
            reply_to_message_id: None,
            attachment_ids: message
                .documents
                .iter()
                .map(|document| document.attachment_id.clone())
                .collect(),
        },
    )
    .await;
    match sent {
        Ok(outcome) => Ok(Some(outcome.value.id.to_string())),
        // A repeated sweep: the first one already posted it.
        Err(StoreError::IdempotencyKeyReused) => {
            let existing: Option<(Uuid,)> = query_as(
                "SELECT message_id FROM cloud_chat_messages \
                 WHERE sender_account_id = $1 AND client_message_id = $2",
            )
            .bind(message.owner_account_id)
            .bind(client_message_id)
            .fetch_optional(pool)
            .await?;
            Ok(existing.map(|(id,)| id.to_string()))
        }
        Err(StoreError::Database(error)) => Err(error),
        Err(error) => {
            eprintln!("[documents] fallback document message: {error}");
            Ok(None)
        }
    }
}
