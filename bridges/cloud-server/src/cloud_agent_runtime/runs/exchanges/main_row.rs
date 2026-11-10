//! The asking agent's one visible row for a task: the reply slot of the run a
//! person started (#2416: it becomes the reply in place and keeps its place).
//! When the agent asks another agent or a person, that slot shows who it waits
//! for instead of being emptied; when an answer arrives it shows processing;
//! the resumed task's result replaces it. The question itself stays a plain
//! message without progress.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;

#[derive(Clone, Debug)]
pub(super) enum Change {
    Waiting {
        name: String,
        account: String,
    },
    Processing,
    Answer(String),
    /// The task's result is already visible; the slot leaves without a bubble.
    Silent,
    Failed,
    Stopped,
}

const STATUS_KEYS: [&str; 4] = [
    "agentExchangeStatus",
    "agentExchangeWaitingFor",
    "agentExchangeWaitingForAccountId",
    "agentExchangeWaitingForRequester",
];

/// Applies `change` to the root run's slot of `exchange`'s task. A run that
/// answers another agent has its own reply row instead and is left alone.
/// Returns whether the task had a slot to change.
pub(super) async fn set(
    tx: &mut Transaction<'_, Postgres>,
    exchange: Uuid,
    change: Change,
) -> RunResult<bool> {
    let parent: Option<(String,)> =
        query_as("SELECT parent_run_id FROM cloud_agent_exchanges WHERE exchange_id=$1")
            .bind(exchange)
            .fetch_optional(&mut **tx)
            .await?;
    let Some((parent,)) = parent else {
        return Ok(false);
    };
    if super::answering::answered_exchange(tx, &parent)
        .await?
        .is_some()
    {
        return Ok(false);
    }
    let row: Option<(String, Uuid, Value)> = query_as(
        "SELECT m.sender_account_id,m.client_message_id,m.content FROM cloud_agent_exchanges e
         JOIN cloud_agent_fallback_runs r ON r.run_id=e.root_run_id
         JOIN cloud_chat_messages m ON m.message_id::text=r.response_message_id AND m.sender_account_id=r.owner_account_id
         WHERE e.exchange_id=$1 AND m.deleted_at IS NULL FOR UPDATE OF m",
    )
    .bind(exchange)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((sender, client, mut content)) = row else {
        return Ok(false);
    };
    let Some(block) = content["blocks"]
        .as_array_mut()
        .and_then(|blocks| blocks.iter_mut().find(|b| b["type"] == "text"))
    else {
        return Ok(false);
    };
    let Some((prefix, encoded)) = block["text"].as_str().and_then(|text| text.split_once(':'))
    else {
        return Ok(false);
    };
    let prefix = prefix.to_owned();
    let group = prefix == "kordi-cloud-group";
    if !group && prefix != "kordi-cloud-agent-response" {
        return Ok(false);
    }
    let Some(mut wire) = URL_SAFE_NO_PAD
        .decode(encoded)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
        return Ok(false);
    };
    apply(&mut wire, group, &change);
    block["text"] = json!(format!(
        "{prefix}:{}",
        URL_SAFE_NO_PAD.encode(wire.to_string())
    ));
    crate::chat_sync::store::replace_server_message_in_transaction(
        tx, &sender, client, "text", content,
    )
    .await
    .map_err(|_| RunError::NotFound)?;
    Ok(true)
}

/// Whether `exchange`'s task has a slot of its own (and is not an answering run).
pub(super) async fn exists(tx: &mut Transaction<'_, Postgres>, exchange: Uuid) -> RunResult<bool> {
    let (parent,): (String,) =
        query_as("SELECT parent_run_id FROM cloud_agent_exchanges WHERE exchange_id=$1")
            .bind(exchange)
            .fetch_one(&mut **tx)
            .await?;
    if super::answering::answered_exchange(tx, &parent)
        .await?
        .is_some()
    {
        return Ok(false);
    }
    let (slot,): (bool,) = query_as("SELECT EXISTS(SELECT 1 FROM cloud_agent_exchanges e JOIN cloud_agent_fallback_runs r ON r.run_id=e.root_run_id JOIN cloud_chat_messages m ON m.message_id::text=r.response_message_id WHERE e.exchange_id=$1 AND m.deleted_at IS NULL)")
        .bind(exchange)
        .fetch_one(&mut **tx)
        .await?;
    Ok(slot)
}

/// The slot's wire message after `change`. A failure or stop applies only to
/// a slot that is still waiting or processing, never to a finished answer.
pub(super) fn apply(wire: &mut Value, group: bool, change: &Change) {
    let message = if group {
        &mut wire["message"]
    } else {
        &mut *wire
    };
    let meta_of = |message: &mut Value| -> Value {
        if group {
            message["structuredContent"].clone()
        } else {
            message.clone()
        }
    };
    let pending = meta_of(message)["agentExchangeStatus"].is_string();
    if matches!(change, Change::Failed | Change::Stopped) && !pending {
        return;
    }
    if group && !message["structuredContent"].is_object() {
        message["structuredContent"] = json!({});
    }
    {
        let meta = if group {
            &mut message["structuredContent"]
        } else {
            &mut *message
        };
        let object = meta.as_object_mut().expect("object");
        for key in STATUS_KEYS {
            object.remove(key);
        }
        object.remove("synchronizationOnly");
        object.remove("agentExchangeOutcome");
        match change {
            Change::Waiting { name, account } => {
                object.insert("agentExchangeStatus".into(), json!("waiting"));
                object.insert("agentExchangeWaitingFor".into(), json!(name));
                object.insert("agentExchangeWaitingForAccountId".into(), json!(account));
            }
            Change::Processing => {
                object.insert("agentExchangeStatus".into(), json!("processing"));
            }
            Change::Silent => {
                object.insert("synchronizationOnly".into(), json!(true));
            }
            _ => {}
        }
    }
    // The task is still open while it waits: the slot stays in progress and
    // says whom it waits for, so no client shows a blank or finished row.
    let (state, text) = match change {
        Change::Waiting { name, .. } => ("processing", format!("Waiting for {name}.")),
        Change::Processing => ("processing", String::new()),
        Change::Silent => ("complete", String::new()),
        Change::Answer(text) => ("complete", text.clone()),
        Change::Failed => ("failed", super::slots::FAILED_TEXT.to_owned()),
        Change::Stopped => ("cancelled", "Stopped".to_owned()),
    };
    message["deliveryState"] = json!(state);
    message["text"] = json!(text);
}

/// After `run` yields to wait, its task's slot names whom it waits for.
pub(crate) async fn show_waiting(pool: &PgPool, run: &str) -> RunResult<()> {
    let Some((name, account)) = super::outcome::waiting_target(pool, run).await? else {
        return Ok(());
    };
    let (exchange,): (Uuid,) = query_as("SELECT exchange_id FROM cloud_agent_exchanges WHERE parent_run_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1")
        .bind(run)
        .fetch_one(pool)
        .await?;
    let mut tx = pool.begin().await?;
    if set(&mut tx, exchange, Change::Waiting { name, account }).await? {
        super::progress::clear(&mut tx, exchange).await?;
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_slot_waits_then_processes_then_answers_in_place() {
        let mut wire = json!({"kind":"agent-response","requestId":"r","text":"","deliveryState":"complete","synchronizationOnly":true,"agentExchangeOutcome":"waiting"});
        apply(
            &mut wire,
            false,
            &Change::Waiting {
                name: "Beta".into(),
                account: "b".into(),
            },
        );
        assert_eq!(wire["agentExchangeStatus"], "waiting");
        assert_eq!(wire["agentExchangeWaitingFor"], "Beta");
        assert_eq!(wire["text"], "Waiting for Beta.", "never a blank row");
        assert_eq!(
            wire["deliveryState"], "processing",
            "the task is still open"
        );
        assert!(wire.get("synchronizationOnly").is_none(), "never emptied");
        apply(&mut wire, false, &Change::Processing);
        assert_eq!(wire["agentExchangeStatus"], "processing");
        assert_eq!(wire["deliveryState"], "processing");
        apply(&mut wire, false, &Change::Answer("Saturday 10am".into()));
        assert_eq!(wire["text"], "Saturday 10am");
        assert!(wire.get("agentExchangeStatus").is_none());
        // A finished answer stays when a late failure arrives.
        apply(&mut wire, false, &Change::Failed);
        assert_eq!(wire["text"], "Saturday 10am");
    }

    #[test]
    fn a_group_slot_keeps_its_envelope_and_ends_cleanly() {
        let mut wire = json!({"kind":"group-message","message":{"id":"m","text":"","deliveryState":"complete","structuredContent":{"synchronizationOnly":true}}});
        apply(&mut wire, true, &Change::Processing);
        assert_eq!(
            wire["message"]["structuredContent"]["agentExchangeStatus"],
            "processing"
        );
        let mut silent = wire.clone();
        apply(&mut silent, true, &Change::Silent);
        assert_eq!(
            silent["message"]["structuredContent"]["synchronizationOnly"],
            true
        );
        apply(&mut wire, true, &Change::Stopped);
        assert_eq!(wire["message"]["deliveryState"], "cancelled");
        assert_eq!(wire["message"]["text"], "Stopped");
    }
}
