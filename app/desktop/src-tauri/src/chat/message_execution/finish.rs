//! Completing a turn: its final state, its transcript entry, and why it stopped.

use std::sync::{Arc, Mutex};

use kordi_cli::desktop_runtime::{DesktopChatMessage, DesktopChatSessionDetail};

use super::super::{
    desktop_task_tools_from_messages, now_millis, sync_completed_desktop_session_to_canonical,
    turn_snapshot_has_model_task_tools, update_turn, DesktopChatTurnSnapshot,
};
use super::fail_chat_request;

pub(super) fn latest_turn_assistant(
    messages: &[DesktopChatMessage],
) -> Option<&DesktopChatMessage> {
    messages
        .iter()
        .rev()
        .take_while(|message| !message.role.trim().eq_ignore_ascii_case("user"))
        .find(|message| message.role.trim().eq_ignore_ascii_case("assistant"))
}

/// The reply of a finished turn as its transcript stores it: it keeps text
/// written before the turn's last tool call (see
/// `kordi_core::types::fold_turn_reply_segments`), while the streamed text runs
/// every message's text together without breaks.
pub(super) fn finished_turn_reply_text(assistant: Option<&DesktopChatMessage>) -> Option<String> {
    let message = assistant.filter(|message| !message.failed && !message.cancelled)?;
    (!message.text.trim().is_empty()).then(|| message.text.clone())
}

pub(super) fn latest_turn_assistant_entry_id(messages: &[DesktopChatMessage]) -> Option<String> {
    latest_turn_assistant(messages).and_then(|message| message.entry_id.clone())
}

pub(super) async fn finish_turn(
    snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>,
    session_handle: &super::super::DesktopSessionHandle,
    cwd: &std::path::Path,
    session_id: &str,
    is_agent_builder_session: bool,
    cancel: &tokio_util::sync::CancellationToken,
    result: Result<DesktopChatSessionDetail, String>,
) {
    if cancel.is_cancelled() {
        record_background_stop_reason(snapshot, session_id);
    }
    match result {
        Ok(detail) if cancel.is_cancelled() => {
            let transcript_entry_id = latest_turn_assistant_entry_id(&detail.messages);
            sync_completed_session(cwd, session_id, session_handle, is_agent_builder_session).await;
            update_turn(snapshot, |state| {
                state.status = "cancelled".to_string();
                state.message = "Response stopped".to_string();
                state.completed = true;
                state.completed_at_ms = Some(now_millis());
                state.transcript_entry_id = transcript_entry_id;
                state.succeeded = false;
                state.error = None;
            });
        }
        Ok(detail) => {
            let transcript_entry_id = latest_turn_assistant_entry_id(&detail.messages);
            let assistant = latest_turn_assistant(&detail.messages);
            let segments = assistant
                .map(|message| message.segments.clone())
                .unwrap_or_default();
            let reply_text = finished_turn_reply_text(assistant);
            sync_completed_session(cwd, session_id, session_handle, is_agent_builder_session).await;
            let task_tools = {
                let session = session_handle.lock().await;
                session
                    .detail()
                    .map(|detail| desktop_task_tools_from_messages(&detail.messages))
                    .unwrap_or_default()
            };
            update_turn(snapshot, |state| {
                if !task_tools.is_empty() && !turn_snapshot_has_model_task_tools(&state.tools) {
                    state.tools = task_tools;
                }
                if !segments.is_empty() {
                    state.segments = segments;
                }
                if let Some(text) = reply_text {
                    state.assistant_text = text;
                }
                state.status = "succeeded".to_string();
                state.message = "Response complete".to_string();
                state.completed = true;
                state.completed_at_ms = Some(now_millis());
                state.transcript_entry_id = transcript_entry_id;
                state.succeeded = true;
                state.error = None;
            });
        }
        Err(_) if cancel.is_cancelled() => update_turn(snapshot, |state| {
            state.status = "cancelled".to_string();
            state.message = "Response stopped".to_string();
            state.completed = true;
            state.completed_at_ms = Some(now_millis());
            state.succeeded = false;
            state.error = None;
        }),
        Err(error) => {
            // Provider failures can still persist a terminal assistant entry.
            // Sync that entry before completing the live turn so Cloud receives
            // the failed response immediately instead of leaving a processing
            // placeholder until fallback timeout.
            sync_completed_session(cwd, session_id, session_handle, is_agent_builder_session).await;
            fail_chat_request(snapshot, error);
        }
    }
}

/// Keeps why a background session's turn was stopped with its transcript, so
/// the session row and the cloud record can name it after a restart. Other
/// sessions have no such record.
fn record_background_stop_reason(snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>, session_id: &str) {
    let Some(reason) = snapshot
        .lock()
        .ok()
        .and_then(|state| state.stop_reason.clone())
    else {
        return;
    };
    let Ok(value) = serde_json::to_value(&reason) else {
        return;
    };
    if let Err(error) =
        kordi_cli::desktop_runtime::record_background_stop_reason(session_id, &value)
    {
        eprintln!("[background-session] could not record why {session_id} stopped: {error}");
    }
}

async fn sync_completed_session(
    cwd: &std::path::Path,
    session_id: &str,
    session_handle: &super::super::DesktopSessionHandle,
    is_agent_builder_session: bool,
) {
    if !is_agent_builder_session {
        sync_completed_desktop_session_to_canonical(cwd, session_id, session_handle).await;
    }
}
