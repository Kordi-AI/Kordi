//! The visible slot of the one run that has no row of its own: an agent
//! answering another agent's request (`:reply`, created with the question).
//! It shows processing at once and becomes the answer in place; while that
//! agent waits for its own owner the row is retired, and it reopens when the
//! owner replies. The asking agent's task uses its own slot (`main_row`).
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;

/// The stable message id of the answering agent's reply slot: the exchange id.
pub(super) fn slot_id(request: &str) -> Option<Uuid> {
    let exchange = request.strip_prefix(PREFIX)?.strip_suffix(":reply")?;
    Uuid::parse_str(exchange).ok()
}

/// How a slot row ends when its run produced no answer of its own.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Ending {
    /// Waiting: the row disappears (complete, empty, synchronization only).
    Retired,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reply_slot_is_the_exchange_id() {
        let exchange = Uuid::new_v4();
        assert_eq!(
            slot_id(&format!("{PREFIX}{exchange}:reply")),
            Some(exchange)
        );
        assert_eq!(slot_id(&format!("{PREFIX}{exchange}:continued")), None);
        assert_eq!(slot_id("other"), None);
    }
}
