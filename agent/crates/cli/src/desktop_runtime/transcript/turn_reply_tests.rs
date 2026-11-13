//! A turn whose summary was written before its last tool call keeps that
//! summary in the reply. The fixture follows the shape of an OMP Codex turn:
//! the summary is `commentary` text beside a failing tool call, and the
//! closing question is the `final_answer`.

use anyhow::Result;
use chrono::Utc;
use kordi_core::types::{
    AgentMessage, AssistantContent, AssistantMessage, ContentBlock, EntryBase, EntryId,
    SessionEntry, StopReason, ToolResultMessage, Usage, UserMessage,
};

use super::load_session_messages;
use crate::omp_turn::RAW_OMP_MESSAGE;

const FINAL: &str = "Please paste the Slack channel link you want me to check. \
The Slack app is open, but I cannot read a channel without its link.";

fn summary() -> String {
    let mut text = String::from("Here is your GitHub summary. You have 50 notifications:");
    for (index, line) in [
        "review requested on the sign-in window fix",
        "review requested on the memory categories change",
        "new comments on the composer pull request",
        "CI failed on the default branch after the latest merge",
        "a mention in the release checklist issue",
        "two dependency update pull requests are ready to merge",
    ]
    .iter()
    .enumerate()
    {
        text.push_str(&format!("\n{}. {line}.", index + 1));
    }
    text.push_str(
        "\nThe rest are subscription updates on issues you follow. \
         The review requests are the oldest and have waited more than two days, \
         so they are the best place to start. The failing CI run blocks merges \
         for everyone, so it may need attention first.",
    );
    text
}

fn append(conn: &rusqlite::Connection, session_id: &str, message: AgentMessage) -> Result<()> {
    let id = EntryId::generate();
    let entry = SessionEntry::Message {
        base: EntryBase {
            id: id.clone(),
            parent_id: crate::turn_runner::get_leaf_raw(conn, session_id),
            timestamp: Utc::now(),
        },
        message,
    };
    kordi_session::store::append_entry(conn, session_id, &entry)?;
    // OMP stores provider replay data after each message; it is no turn boundary.
    let sidecar = SessionEntry::Custom {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id: Some(id.clone()),
            timestamp: Utc::now(),
        },
        custom_type: RAW_OMP_MESSAGE.to_string(),
        data: Some(serde_json::json!({ "entryId": id.as_str(), "routeScope": "test" })),
    };
    kordi_session::store::append_entry(conn, session_id, &sidecar)?;
    Ok(())
}

fn assistant(content: Vec<AssistantContent>, stop_reason: StopReason, at: i64) -> AgentMessage {
    AgentMessage::Assistant(AssistantMessage {
        content,
        provider: "openai-codex".to_string(),
        model: "gpt-test".to_string(),
        usage: Usage::default(),
        stop_reason,
        error_message: None,
        timestamp: at,
    })
}

fn call(id: &str, name: &str) -> AssistantContent {
    AssistantContent::ToolCall {
        id: id.to_string(),
        name: name.to_string(),
        arguments: serde_json::json!({}),
    }
}

fn result(id: &str, name: &str, text: &str, is_error: bool, at: i64) -> AgentMessage {
    AgentMessage::ToolResult(ToolResultMessage {
        tool_call_id: id.to_string(),
        tool_name: name.to_string(),
        content: vec![ContentBlock::Text {
            text: text.to_string(),
        }],
        details: None,
        is_error,
        timestamp: at,
    })
}

#[test]
fn reply_keeps_the_summary_written_before_the_last_tool_call() -> Result<()> {
    let conn = kordi_session::store::open_memory()?;
    let session_id = "desktop-reply-keeps-earlier-text";
    kordi_session::store::create_session_with_id(&conn, session_id, "/tmp/kordi")?;
    let summary = summary();

    let user = AgentMessage::User(UserMessage {
        content: vec![ContentBlock::Text {
            text: "check my github and slack content".to_string(),
        }],
        timestamp: 1_000,
    });
    append(&conn, session_id, user)?;
    let first = vec![
        AssistantContent::Thinking {
            thinking: "Start with GitHub notifications.".to_string(),
        },
        call("call-gh", "github_notifications"),
        call("call-search", "search_sessions"),
    ];
    append(
        &conn,
        session_id,
        assistant(first, StopReason::ToolUse, 2_000),
    )?;
    append(
        &conn,
        session_id,
        result(
            "call-gh",
            "github_notifications",
            "50 notifications",
            false,
            2_100,
        ),
    )?;
    append(
        &conn,
        session_id,
        result(
            "call-search",
            "search_sessions",
            "no sessions",
            false,
            2_200,
        ),
    )?;
    let second = vec![
        AssistantContent::Text {
            text: "Checking Slack on this Mac:".to_string(),
        },
        call("call-apps", "local_app"),
        call("call-tabs", "local_app"),
    ];
    append(
        &conn,
        session_id,
        assistant(second, StopReason::ToolUse, 3_000),
    )?;
    append(
        &conn,
        session_id,
        result("call-apps", "local_app", "Slack, Chrome", false, 3_100),
    )?;
    append(
        &conn,
        session_id,
        result("call-tabs", "local_app", "no Slack tab", false, 3_200),
    )?;
    let third = vec![
        AssistantContent::Text {
            text: summary.clone(),
        },
        call("call-reach", "reach_out"),
    ];
    append(
        &conn,
        session_id,
        assistant(third, StopReason::ToolUse, 4_000),
    )?;
    append(
        &conn,
        session_id,
        result("call-reach", "reach_out", "reach_out failed", true, 4_100),
    )?;
    let last = vec![AssistantContent::Text {
        text: FINAL.to_string(),
    }];
    append(&conn, session_id, assistant(last, StopReason::Stop, 5_000))?;

    let messages = load_session_messages(&conn, session_id)?;
    assert_eq!(messages.len(), 2, "one user request and one assistant turn");
    let reply = messages.last().expect("assistant turn");
    assert!(!reply.failed && !reply.cancelled);
    let expected = format!("{summary}\n\n{FINAL}");
    assert_eq!(reply.text, expected);
    assert!(
        !reply.text.contains("Start with GitHub"),
        "reasoning stays out"
    );
    assert!(
        !reply.text.contains("Checking Slack"),
        "a short preamble stays out"
    );
    assert_eq!(
        reply.thinking_text.as_deref(),
        Some("Start with GitHub notifications.")
    );

    // Clients show the last text segment as the reply and the rest in the
    // activity disclosure: the reply segment carries the summary, the
    // summary's own segment is emptied, and the preamble stays where it was.
    let texts = reply
        .segments
        .iter()
        .filter_map(|segment| match segment {
            kordi_core::types::TurnSegment::Text { text, .. } if !text.is_empty() => {
                Some(text.as_str())
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        texts,
        vec!["Checking Slack on this Mac:", expected.as_str()]
    );
    assert_eq!(reply.tools.len(), 5);
    Ok(())
}
