use super::{
    finished_turn_reply_text, latest_turn_assistant, latest_turn_assistant_entry_id,
    reserve_shared_request, shared_request_runtime_session_id, DesktopChatManager,
};
use kordi_cli::desktop_runtime::DesktopChatMessage;

fn message(role: &str, entry_id: Option<&str>) -> DesktopChatMessage {
    DesktopChatMessage {
        role: role.to_string(),
        sender: None,
        text: String::new(),
        detail: None,
        time_label: String::new(),
        timestamp_ms: 0,
        failed: false,
        cancelled: false,
        attachments: Vec::new(),
        thinking_text: None,
        segments: Vec::new(),
        tools: Vec::new(),
        entry_id: entry_id.map(str::to_string),
    }
}

#[tokio::test]
async fn shared_request_is_admitted_once_per_runtime() {
    let manager = DesktopChatManager::default();

    assert!(reserve_shared_request(&manager, "runtime-a", "request-1").await);
    assert!(!reserve_shared_request(&manager, "runtime-a", "request-1").await);
    assert!(reserve_shared_request(&manager, "runtime-b", "request-1").await);
}

#[tokio::test]
async fn shared_requests_use_distinct_internal_runtimes_without_double_scoping() {
    let manager = DesktopChatManager::default();
    let base = "cloud-agent:owner:conversation";
    let first = shared_request_runtime_session_id(base, "request-a").unwrap();
    let second = shared_request_runtime_session_id(base, "request-b").unwrap();
    assert_eq!(first, format!("{base}:request:request-a"));
    assert_ne!(first, second);
    assert!(crate::chat::canonical_sync::is_cloud_agent_runtime_session_id(&first));
    let scoped = shared_request_runtime_session_id(&first, " request-a ").unwrap();
    assert_eq!(scoped, first);
    assert!(reserve_shared_request(&manager, &first, "request-a").await);
    assert!(!reserve_shared_request(&manager, &scoped, "request-a").await);
    assert!(reserve_shared_request(&manager, &second, "request-b").await);
    assert!(shared_request_runtime_session_id(base, " ").is_err());
    assert!(shared_request_runtime_session_id(" ", "request-a").is_err());
    assert!(shared_request_runtime_session_id("private-agent-chat", "request-a").is_err());
}

#[test]
fn current_turn_assistant_entry_id_stops_at_latest_user_boundary() {
    let messages = vec![
        message("assistant", Some("entry:old")),
        message("user", Some("entry:user")),
    ];

    assert_eq!(latest_turn_assistant_entry_id(&messages), None);
}

#[test]
fn current_turn_assistant_entry_id_returns_the_new_reply() {
    let messages = vec![
        message("assistant", Some("entry:old")),
        message("user", Some("entry:user")),
        message("assistant", Some("entry:new")),
    ];

    assert_eq!(
        latest_turn_assistant_entry_id(&messages).as_deref(),
        Some("entry:new")
    );
}

#[test]
fn finished_turn_reply_is_the_current_turns_stored_reply() {
    let mut reply = message("assistant", Some("entry:new"));
    reply.text = "Here is your GitHub summary.\n\nPlease paste the Slack channel link.".into();
    let mut earlier = message("assistant", Some("entry:old"));
    earlier.text = "An older answer.".into();
    let messages = vec![
        earlier.clone(),
        message("user", Some("entry:user")),
        reply.clone(),
    ];

    let assistant = latest_turn_assistant(&messages);
    assert_eq!(
        finished_turn_reply_text(assistant).as_deref(),
        Some(reply.text.as_str())
    );
    // A turn with no reply of its own never borrows an earlier one.
    let unanswered = vec![earlier, message("user", Some("entry:user"))];
    assert_eq!(
        finished_turn_reply_text(latest_turn_assistant(&unanswered)),
        None
    );
    // A failed or empty reply keeps the streamed text.
    reply.failed = true;
    assert_eq!(finished_turn_reply_text(Some(&reply)), None);
    assert_eq!(
        finished_turn_reply_text(Some(&message("assistant", None))),
        None
    );
}
