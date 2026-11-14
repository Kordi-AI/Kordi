//! A person asking the System agent directly ("@Facilitator …") is picked up
//! on the next sweep tick instead of waiting for the chat to go quiet. The
//! send path marks the sweep row with the request's sequence; the sweep's
//! quiet wait does not apply while that sequence is still unseen.

use sqlx_core::query::query;
use sqlx_postgres::PgPool;

use crate::chat_sync::models::MessageSnapshot;

/// The sweep row key holding the newest direct request's sequence.
pub(super) const REQUEST_SEQUENCE_KEY: &str = "requestSequence";

/// Whether a person's message asks the System agent itself.
pub(super) fn asks_system_agent(message: &MessageSnapshot, system_agent: &str) -> bool {
    if message.sender_account_id == system_agent
        || crate::system_account::is_service_account(&message.sender_account_id)
    {
        return false;
    }
    let envelope = super::input::content_envelope(&message.content);
    if envelope.as_ref().is_some_and(|envelope| {
        envelope["message"]["senderKind"] == "agent" || envelope["senderKind"] == "agent"
    }) {
        return false;
    }
    envelope
        .as_ref()
        .is_some_and(|envelope| super::addressing::addresses_system_agent(envelope, system_agent))
        || super::addressing::starts_with_facilitator_mention(
            &super::input::message_text(&message.content),
            &Default::default(),
        )
}

/// Marks the conversation so its next sweep takes `message` right away.
/// A message that does not ask the System agent changes nothing.
pub async fn note_direct_request(
    pool: &PgPool,
    message: &MessageSnapshot,
) -> Result<(), sqlx_core::Error> {
    match super::service_account_id() {
        Some(system_agent) => mark(pool, message, system_agent).await,
        None => Ok(()),
    }
}

pub(super) async fn mark(
    pool: &PgPool,
    message: &MessageSnapshot,
    system_agent: &str,
) -> Result<(), sqlx_core::Error> {
    if !asks_system_agent(message, system_agent) {
        return Ok(());
    }
    query(
        "UPDATE cloud_pip_conversation_state
         SET hooks_fired = hooks_fired || jsonb_build_object($2::text, $3::bigint),
             updated_at = now()
         WHERE conversation_id = $1",
    )
    .bind(message.conversation_id)
    .bind(REQUEST_SEQUENCE_KEY)
    .bind(message.conversation_sequence)
    .execute(pool)
    .await?;
    Ok(())
}
