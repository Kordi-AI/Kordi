//! The Facilitator's visible reply row for a direct request ("@Facilitator
//! …"). As soon as a run takes the request, the Facilitator shows a
//! processing row answering it, in the same reply-slot shape as member
//! agents' rows (#2547). The run's end edits that row in place: its words
//! replace it, and a card or document it opened is the reply, so the row
//! goes. A failed run removes its row too, so no row is left working; the
//! retry shows a new one.

use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::chat_sync::models::SendMessageRequest;
use crate::cloud_agent_runtime::runs::facilitator_slot;
use crate::document_shares::agents::create::reply::RunDocument;

/// The newest new message in a run input that asks the System agent itself.
pub(super) fn request_message(input: &Value) -> Option<Uuid> {
    input["messages"]
        .as_array()?
        .iter()
        .rev()
        .find(|message| message["addressesSystemAgent"] == true && message["isNew"] == true)
        .and_then(|message| message["messageId"].as_str())
        .and_then(|id| Uuid::parse_str(id).ok())
}

/// One row per run: a failed run's row is gone, and its retry shows its own.
fn slot_client_id(run_id: &str) -> Uuid {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("facilitator-reply:{run_id}").as_bytes(),
    )
}

fn content(body: String) -> Value {
    json!({"schema": 1, "blocks": [{"type": "text", "text": body}], "legacy_attachments": []})
}

/// The stored body of the request message, when it is a group message.
async fn request_body(
    pool: &PgPool,
    conversation_id: Uuid,
    request: Uuid,
) -> Result<Option<String>, sqlx_core::Error> {
    let row: Option<(Value,)> = query_as(
        "SELECT content FROM cloud_chat_messages
         WHERE message_id = $1 AND conversation_id = $2 AND deleted_at IS NULL",
    )
    .bind(request)
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(|(content,)| {
        content["blocks"][0]["text"]
            .as_str()
            .filter(|body| facilitator_slot::request_id(body).is_some())
            .map(str::to_string)
    }))
}

/// Writes the row's body: edits the slot in place, or posts it the first
/// time. Returns the row's message id.
async fn write(
    pool: &PgPool,
    system_agent: &str,
    conversation_id: Uuid,
    run_id: &str,
    body: String,
) -> Result<Option<String>, sqlx_core::Error> {
    let client_id = slot_client_id(run_id);
    let mut tx = pool.begin().await?;
    let replaced = crate::chat_sync::store::replace_server_message_in_transaction(
        &mut tx,
        system_agent,
        client_id,
        "text",
        content(body.clone()),
    )
    .await
    .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    let message = match replaced {
        Some(message) => message,
        None => {
            let request = SendMessageRequest {
                client_message_id: client_id,
                kind: "text".to_string(),
                content: content(body),
                reply_to_message_id: None,
                attachment_ids: Vec::new(),
            };
            crate::chat_sync::store::send_message_in_transaction(
                &mut tx,
                system_agent,
                conversation_id,
                request,
            )
            .await
            .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?
            .value
        }
    };
    tx.commit().await?;
    Ok(Some(message.id.to_string()))
}

async fn write_state(
    pool: &PgPool,
    system_agent: &str,
    conversation_id: Uuid,
    (run_id, request): (&str, Uuid),
    text: &str,
    delivery_state: &str,
    mentions: Vec<Value>,
) -> Result<Option<String>, sqlx_core::Error> {
    let Some(request_body) = request_body(pool, conversation_id, request).await? else {
        return Ok(None);
    };
    let slot_id = format!("facilitator-reply:{run_id}");
    let agent: Option<(String,)> = query_as(
        "SELECT agent_id FROM cloud_agent_definitions
         WHERE owner_account_id = $1 AND is_system_managed AND status = 'active'
         ORDER BY agent_id LIMIT 1",
    )
    .bind(system_agent)
    .fetch_optional(pool)
    .await?;
    let row = facilitator_slot::ReplyRow {
        system_agent,
        agent_id: agent.as_ref().map(|(id,)| id.as_str()),
        slot_id: &slot_id,
        text,
        delivery_state,
        mentions,
        created_at_ms: Utc::now().timestamp_millis(),
    };
    let Some(body) = facilitator_slot::reply_body(&request_body, row) else {
        return Ok(None);
    };
    write(pool, system_agent, conversation_id, run_id, body).await
}

/// Shows the processing row for the run that just took a direct request,
/// and records it as the run's reply.
pub(super) async fn open(
    pool: &PgPool,
    system_agent: &str,
    run_id: &str,
    conversation_id: Uuid,
    input: &Value,
) -> Result<(), sqlx_core::Error> {
    if input["trigger"]["kind"] != "request" {
        return Ok(());
    }
    let Some(request) = request_message(input) else {
        return Ok(());
    };
    let row = write_state(
        pool,
        system_agent,
        conversation_id,
        (run_id, request),
        "",
        "processing",
        Vec::new(),
    )
    .await?;
    if let Some(row) = row {
        query("UPDATE cloud_agent_fallback_runs SET response_message_id = $2 WHERE run_id = $1")
            .bind(run_id)
            .bind(row)
            .execute(pool)
            .await?;
    }
    Ok(())
}

/// The reply to a direct request when the model returned nothing to post.
pub(super) const REQUEST_FALLBACK: &str =
    "Hi! I can find a time, open a vote, or keep track of who does what. Just ask.";

/// `open`, logged instead of failing the run that was just queued.
pub(super) async fn show(
    pool: &PgPool,
    system_agent: &str,
    run_id: &str,
    conversation_id: Uuid,
    input: &Value,
) {
    if let Err(error) = open(pool, system_agent, run_id, conversation_id, input).await {
        eprintln!("[system-agent] Could not show the reply row for {run_id}: {error}");
    }
}

/// Posts a finished run's words. Someone who asked the System agent directly
/// always gets an answer, in their request's row: the words replace it in
/// place, and a card or document the run opened is the answer instead, so
/// the row goes. Returns the message that holds the words.
pub(super) async fn publish(
    pool: &PgPool,
    run_id: &str,
    run: &super::store::ActiveRun,
    message: Option<&str>,
    answered: bool,
    card_touched: bool,
    documents: &[RunDocument],
) -> Result<Option<String>, sqlx_core::Error> {
    let asked_directly = run.input["trigger"]["kind"] == "request";
    let answered = answered || message.is_some() || !documents.is_empty();
    let text = message
        .or_else(|| (!documents.is_empty()).then_some("I drafted a document for the group."))
        .or_else(|| (asked_directly && !answered).then_some(REQUEST_FALLBACK))
        .filter(|text| !text.is_empty());
    let (sender, conversation_id) = (run.owner_account_id.as_str(), run.conversation_id);
    let Some(text) = text else {
        finish(
            pool,
            run_id,
            sender,
            conversation_id,
            &run.input,
            Ending::Answered,
        )
        .await?;
        return Ok(None);
    };
    if documents.is_empty() {
        let (words, mentions) = super::post::reply_text(pool, run, text, card_touched).await?;
        let ending = Ending::Reply(&words, mentions);
        if let Some(row) = finish(pool, run_id, sender, conversation_id, &run.input, ending).await?
        {
            return Ok(Some(row));
        }
    }
    let posted = super::post::post_text(pool, run_id, run, text, card_touched, documents).await?;
    if !documents.is_empty() {
        finish(
            pool,
            run_id,
            sender,
            conversation_id,
            &run.input,
            Ending::Answered,
        )
        .await?;
    }
    Ok(posted)
}

/// What ends a request's row.
pub(super) enum Ending<'a> {
    /// The Facilitator's words, with their resolved mentions.
    Reply(&'a str, Vec<Value>),
    /// A card or document answered instead; the row goes.
    Answered,
    /// The run failed; the row goes, and the retry shows a new one.
    Failed,
}

/// Ends the run's row. Returns the row's message id when the row now holds
/// the reply, and None when the run had no row or the row is gone.
pub(super) async fn finish(
    pool: &PgPool,
    run_id: &str,
    system_agent: &str,
    conversation_id: Uuid,
    input: &Value,
    ending: Ending<'_>,
) -> Result<Option<String>, sqlx_core::Error> {
    if input["trigger"]["kind"] != "request" {
        return Ok(None);
    }
    let Some(request) = request_message(input) else {
        return Ok(None);
    };
    if let Ending::Reply(text, mentions) = ending {
        let slot = (run_id, request);
        return write_state(
            pool,
            system_agent,
            conversation_id,
            slot,
            text,
            "complete",
            mentions,
        )
        .await;
    }
    let row: Option<(Uuid,)> = query_as(
        "SELECT message_id FROM cloud_chat_messages
         WHERE sender_account_id = $1 AND client_message_id = $2 AND deleted_at IS NULL",
    )
    .bind(system_agent)
    .bind(slot_client_id(run_id))
    .fetch_optional(pool)
    .await?;
    if let Some((message_id,)) = row {
        crate::chat_sync::store::delete_message(
            pool,
            system_agent,
            conversation_id,
            message_id,
            true,
        )
        .await
        .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    }
    Ok(None)
}

#[cfg(test)]
#[path = "reply_slot_tests.rs"]
mod tests;
