//! The visible slot of a run started by an exchange rather than a fresh
//! mention: the answering agent's reply (`:reply`, created with the question)
//! and the asking agent's continuation (`:continued`, created with the resume
//! run). Each shows a processing row as soon as the run exists and becomes
//! the run's answer in place; a run that ends silently or waits retires it,
//! a failure or a stop leaves the matching terminal state, never a spinner.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;

/// The stable message id of an in-place slot: the exchange id for `:reply`,
/// a name-based id derived from it for `:continued`.
pub(super) fn slot_id(request: &str) -> Option<Uuid> {
    let (exchange, kind) = request.strip_prefix(PREFIX)?.rsplit_once(':')?;
    let exchange = Uuid::parse_str(exchange).ok()?;
    match kind {
        "reply" => Some(exchange),
        "continued" => Some(continued_id(exchange)),
        _ => None,
    }
}

pub(super) fn continued_id(exchange: Uuid) -> Uuid {
    Uuid::new_v5(&exchange, b"continued")
}

/// How a slot row ends when its run produced no answer of its own.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Ending {
    /// Silent or waiting: the row disappears (complete, empty, synchronization only).
    Retired,
    /// Stopped or cancelled: the row shows the stopped state.
    Stopped,
    /// Failed without a published reply: the row shows the failure.
    Failed,
}

/// Ends `sender`'s slot row `client` if it is still processing; a row that
/// already holds an answer is left as it is.
pub(super) async fn finish(
    tx: &mut Transaction<'_, Postgres>,
    sender: &str,
    client: Uuid,
    ending: Ending,
) -> RunResult<()> {
    let row: Option<(Value,)> = query_as("SELECT content FROM cloud_chat_messages WHERE sender_account_id=$1 AND client_message_id=$2 AND deleted_at IS NULL FOR UPDATE")
        .bind(sender).bind(client).fetch_optional(&mut **tx).await?;
    let Some((mut content,)) = row else {
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
    let Some(mut wire) = URL_SAFE_NO_PAD
        .decode(encoded)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
        return Ok(());
    };
    let group = prefix == "kordi-cloud-group";
    let message = if group {
        &mut wire["message"]
    } else {
        &mut wire
    };
    if message["deliveryState"] != "processing" {
        return Ok(());
    }
    match ending {
        Ending::Retired => {
            // As a yielded outcome: complete, empty, synchronization only.
            message["deliveryState"] = json!("complete");
            message["text"] = json!("");
            let flags = if group {
                &mut message["structuredContent"]
            } else {
                &mut *message
            };
            if !flags.is_object() {
                *flags = json!({});
            }
            flags["synchronizationOnly"] = json!(true);
        }
        Ending::Stopped => {
            message["deliveryState"] = json!("cancelled");
            message["text"] = json!("Stopped");
        }
        Ending::Failed => {
            message["deliveryState"] = json!("failed");
            message["text"] = json!(FAILED_TEXT);
        }
    }
    block["text"] = json!(format!(
        "{prefix}:{}",
        URL_SAFE_NO_PAD.encode(wire.to_string())
    ));
    crate::chat_sync::store::replace_server_message_in_transaction(
        tx, sender, client, "text", content,
    )
    .await
    .map_err(|_| RunError::NotFound)?;
    Ok(())
}

/// What a failed exchange run shows in its slot.
pub(super) const FAILED_TEXT: &str =
    "The agent could not complete this request, so no answer is available. Please try again.";

/// Ends the continuation slot of `exchange`, whose resume run belongs to the
/// asking run's owner.
pub(super) async fn finish_continued(
    tx: &mut Transaction<'_, Postgres>,
    exchange: Uuid,
    ending: Ending,
) -> RunResult<()> {
    let owner: Option<(String,)> = query_as("SELECT p.owner_account_id FROM cloud_agent_exchanges e JOIN cloud_agent_fallback_runs p ON p.run_id=e.parent_run_id WHERE e.exchange_id=$1")
        .bind(exchange).fetch_optional(&mut **tx).await?;
    match owner {
        Some((owner,)) => finish(tx, &owner, continued_id(exchange), ending).await,
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_have_stable_distinct_ids() {
        let exchange = Uuid::new_v4();
        assert_eq!(
            slot_id(&format!("{PREFIX}{exchange}:reply")),
            Some(exchange)
        );
        let continued = slot_id(&format!("{PREFIX}{exchange}:continued")).unwrap();
        assert_eq!(continued, continued_id(exchange));
        assert_ne!(continued, exchange);
        assert_eq!(slot_id(&format!("{PREFIX}{exchange}:sent")), None);
        assert_eq!(slot_id("other"), None);
    }
}
