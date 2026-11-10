//! Follow-up work after a message is stored. Failures here never fail the send.
use crate::chat_sync::models::MessageSnapshot;
use crate::server::ServerState;

pub(super) async fn message_sent(state: &ServerState, message: &MessageSnapshot) {
    if let Some(notifications) = state.notifications() {
        notifications
            .send_message_attention(state.db_pool(), message)
            .await;
    }
    // The sender may be answering an agent's question; the sweep retries on failure.
    if let Err(error) = crate::cloud_agent_runtime::runs::exchanges::match_person_replies(
        state.db_pool(),
        message.conversation_id,
        &message.sender_account_id,
    )
    .await
    {
        eprintln!("[chat_sync] agent question reply matching: {error}");
    }
    // A person's mention that no agent can take fails visibly for everyone.
    if let Err(error) = crate::cloud_agent_runtime::runs::fail_unroutable_mention(
        state.db_pool(),
        message.conversation_id,
        message.id,
    )
    .await
    {
        eprintln!("[chat_sync] unroutable agent mention: {error}");
    }
}
