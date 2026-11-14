//! Follow-up work after a message is stored. Failures here never fail the send.
use crate::auth::session_metrics::send::{measure, SendStage};
use crate::chat_sync::models::MessageSnapshot;
use crate::server::ServerState;

pub(super) async fn message_sent(state: &ServerState, message: &MessageSnapshot) {
    let metrics = Some(&state.session_signals().lookup_cache().metrics().send);
    if let Some(notifications) = state.notifications() {
        measure(
            metrics,
            SendStage::Notifications,
            notifications.send_message_attention(state.db_pool(), message),
        )
        .await;
    }
    // The sender may be answering an agent's question; the sweep retries on failure.
    if let Err(error) = measure(
        metrics,
        SendStage::ReplyMatching,
        crate::cloud_agent_runtime::runs::exchanges::match_person_replies(
            state.db_pool(),
            message.conversation_id,
            &message.sender_account_id,
        ),
    )
    .await
    {
        eprintln!("[chat_sync] agent question reply matching: {error}");
    }
    // "@Facilitator" skips the sweep's quiet wait; the sweep retries anyway.
    if let Err(error) =
        crate::system_agent::requests::note_direct_request(state.db_pool(), message).await
    {
        eprintln!("[chat_sync] Facilitator request wake: {error}");
    }
    // A person's mention that no agent can take fails visibly for everyone.
    if let Err(error) = measure(
        metrics,
        SendStage::MentionRouting,
        crate::cloud_agent_runtime::runs::fail_unroutable_mention(
            state.db_pool(),
            message.conversation_id,
            message.id,
        ),
    )
    .await
    {
        eprintln!("[chat_sync] unroutable agent mention: {error}");
    }
}
