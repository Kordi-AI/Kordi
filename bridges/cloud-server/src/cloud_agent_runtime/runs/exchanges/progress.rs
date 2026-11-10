//! Keep collaboration progress on its existing public question, not in chat text.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;

pub(super) async fn update(
    tx: &mut Transaction<'_, Postgres>,
    exchange: Uuid,
    state: &str,
) -> RunResult<()> {
    // A timeout or cancellation must retire the recipient's pending row. It is
    // not a received reply and must not authorize a silent continuation.
    if state != "waiting" {
        retire_unanswered(tx, exchange).await?;
    }
    // The asking task's own slot shows the state, so the question stays a
    // plain message; a task without a slot yet keeps it on the question.
    use super::main_row::{set, Change};
    let shown = match state {
        "processing" => set(tx, exchange, Change::Processing).await?,
        "failed" => set(tx, exchange, Change::Failed).await?,
        "cancelled" => set(tx, exchange, Change::Stopped).await?,
        // The result itself already updated the slot.
        "completed" => super::main_row::exists(tx, exchange).await?,
        _ => false,
    };
    if shown {
        return clear(tx, exchange).await;
    }
    patch(tx, exchange, &[("agentExchangeStatus", json!(state))]).await
}

/// Whom the task waits for, with their account so that person's own client
/// can say it waits for them: on the task's slot, else on the question.
/// Older clients read `agentExchangeWaitingForRequester` as "the owner's
/// agent asked the owner", so it is set only for that question.
pub(super) async fn waiting_for(
    tx: &mut Transaction<'_, Postgres>,
    exchange: Uuid,
    name: &str,
    account: &str,
    owner_requester: bool,
) -> RunResult<()> {
    let change = super::main_row::Change::Waiting {
        name: name.to_owned(),
        account: account.to_owned(),
    };
    if super::main_row::set(tx, exchange, change).await? {
        return clear(tx, exchange).await;
    }
    let mut fields = vec![
        ("agentExchangeStatus", json!("waiting")),
        ("agentExchangeWaitingFor", json!(name)),
        ("agentExchangeWaitingForAccountId", json!(account)),
    ];
    if owner_requester {
        fields.push(("agentExchangeWaitingForRequester", json!(true)));
    }
    patch(tx, exchange, &fields).await
}

/// The question leaves its progress to the task's slot.
pub(super) async fn clear(tx: &mut Transaction<'_, Postgres>, exchange: Uuid) -> RunResult<()> {
    patch(
        tx,
        exchange,
        &[
            ("agentExchangeStatus", Value::Null),
            ("agentExchangeWaitingFor", Value::Null),
            ("agentExchangeWaitingForAccountId", Value::Null),
            ("agentExchangeWaitingForRequester", Value::Null),
        ],
    )
    .await
}

pub(super) async fn patch(
    tx: &mut Transaction<'_, Postgres>,
    exchange: Uuid,
    fields: &[(&str, Value)],
) -> RunResult<()> {
    let row: Option<(String, Uuid, Value)> = query_as(
        "SELECT m.sender_account_id,m.client_message_id,m.content FROM cloud_agent_exchanges e JOIN cloud_chat_messages m ON m.message_id=e.request_message_id WHERE e.exchange_id=$1 AND m.deleted_at IS NULL FOR UPDATE OF m",
    ).bind(exchange).fetch_optional(&mut **tx).await?;
    let Some((sender, client_id, mut content)) = row else {
        return Ok(());
    };
    let Some(block) = content["blocks"]
        .as_array_mut()
        .and_then(|blocks| blocks.iter_mut().find(|b| b["type"] == "text"))
    else {
        return Ok(());
    };
    let Some((prefix, encoded)) = block["text"].as_str().and_then(|text| text.split_once(':'))
    else {
        return Ok(());
    };
    let group = prefix == "kordi-cloud-group";
    if !group && prefix != "kordi-cloud-agent-response" {
        return Ok(());
    }
    let prefix = prefix.to_owned();
    let mut wire: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| RunError::NotFound)?,
    )
    .map_err(|_| RunError::NotFound)?;
    let metadata = if group {
        &mut wire["message"]["structuredContent"]
    } else {
        &mut wire
    };
    if !metadata.is_object() {
        *metadata = json!({});
    }
    let before = metadata.clone();
    let object = metadata.as_object_mut().expect("object");
    for (key, value) in fields {
        // A cleared field is removed, so clearing a plain question is a no-op.
        if value.is_null() {
            object.remove(*key);
        } else {
            object.insert((*key).to_owned(), value.clone());
        }
    }
    // Only a real change makes a new version of the message.
    if *metadata == before {
        return Ok(());
    }
    block["text"] = json!(format!(
        "{prefix}:{}",
        URL_SAFE_NO_PAD.encode(wire.to_string())
    ));
    crate::chat_sync::store::replace_server_message_in_transaction(
        tx, &sender, client_id, "text", content,
    )
    .await
    .map_err(|_| RunError::NotFound)?;
    Ok(())
}

async fn retire_unanswered(tx: &mut Transaction<'_, Postgres>, exchange: Uuid) -> RunResult<()> {
    let row: Option<(String, Value)> = query_as(
        "SELECT m.sender_account_id,m.content FROM cloud_agent_exchanges e JOIN cloud_chat_messages m ON m.client_message_id=e.exchange_id AND m.sender_account_id=e.target_owner_id WHERE e.exchange_id=$1 AND e.response_message_id IS NULL FOR UPDATE OF m",
    ).bind(exchange).fetch_optional(&mut **tx).await?;
    let Some((sender, mut content)) = row else {
        return Ok(());
    };
    let Some(block) = content["blocks"]
        .as_array_mut()
        .and_then(|blocks| blocks.iter_mut().find(|b| b["type"] == "text"))
    else {
        return Ok(());
    };
    let Some((prefix, encoded)) = block["text"].as_str().and_then(|text| text.split_once(':'))
    else {
        return Ok(());
    };
    let prefix = prefix.to_owned();
    let mut wire: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| RunError::NotFound)?,
    )
    .map_err(|_| RunError::NotFound)?;
    let message = if prefix == "kordi-cloud-group" {
        &mut wire["message"]
    } else {
        &mut wire
    };
    message["deliveryState"] = json!("cancelled");
    if prefix == "kordi-cloud-group" {
        message["structuredContent"] = json!({"synchronizationOnly":true});
    } else {
        message["synchronizationOnly"] = json!(true);
    }
    block["text"] = json!(format!(
        "{prefix}:{}",
        URL_SAFE_NO_PAD.encode(wire.to_string())
    ));
    crate::chat_sync::store::replace_server_message_in_transaction(
        tx, &sender, exchange, "text", content,
    )
    .await
    .map_err(|_| RunError::NotFound)?;
    Ok(())
}
