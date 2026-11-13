use super::*;
use serde_json::json;

const SUMMARY: &str = "You have 50 GitHub notifications. Three review requests are waiting on you, \
two pull requests you opened have new comments, and one CI run failed on the default branch.";
const FINAL: &str = "Please paste the Slack channel link you want me to check.";

fn text(id: &str, value: &str) -> TurnSegment {
    TurnSegment::Text {
        id: id.into(),
        text: value.into(),
        revision: 1,
    }
}

fn tool(id: &str) -> TurnSegment {
    TurnSegment::Tool {
        id: format!("tool:{id}"),
        tool_id: id.into(),
    }
}

fn segment_text(segment: &TurnSegment) -> &str {
    match segment {
        TurnSegment::Text { text, .. } => text,
        TurnSegment::Tool { .. } => panic!("expected a text segment"),
    }
}

#[test]
fn earlier_text_comes_before_the_final_answer() {
    assert_eq!(
        compose_turn_reply(&[SUMMARY, FINAL]),
        format!("{SUMMARY}\n\n{FINAL}")
    );
}

#[test]
fn a_single_part_is_the_reply() {
    assert_eq!(compose_turn_reply(&["  Done.\n"]), "Done.");
    assert_eq!(compose_turn_reply::<&str>(&[]), "");
    assert_eq!(compose_turn_reply(&["", "  "]), "");
}

#[test]
fn status_preambles_stay_out_of_the_reply() {
    assert!(is_status_preamble("Checking your GitHub notifications:"));
    assert!(is_status_preamble("Looking at Slack…"));
    assert!(is_status_preamble("Opening the Slack app..."));
    // Sentences, long lines, and several lines are content.
    assert!(!is_status_preamble("I checked GitHub."));
    assert!(!is_status_preamble(&format!("{}:", "a".repeat(80))));
    assert!(!is_status_preamble("Here is what I found:\n- one review"));
    assert_eq!(
        compose_turn_reply(&["Checking GitHub:", SUMMARY, "Opening Slack…", FINAL]),
        format!("{SUMMARY}\n\n{FINAL}")
    );
}

#[test]
fn a_final_answer_that_is_only_a_preamble_is_still_kept() {
    assert_eq!(
        compose_turn_reply(&["Checking GitHub:"]),
        "Checking GitHub:"
    );
}

#[test]
fn duplicates_and_text_the_final_answer_contains_are_skipped() {
    let final_answer = format!("{SUMMARY}\n\nAnything else?");
    assert_eq!(
        compose_turn_reply(&[
            SUMMARY,
            "Slack needs a link.",
            "Slack needs a link.",
            &final_answer
        ]),
        format!("Slack needs a link.\n\n{final_answer}")
    );
}

#[test]
fn a_machine_readable_final_answer_stays_alone() {
    let waiting = r#"{"agentExchangeOutcome":"waiting"}"#;
    assert_eq!(compose_turn_reply(&[SUMMARY, waiting]), waiting);
    let mut segments = vec![
        text("text:0", SUMMARY),
        tool("reach_out"),
        text("text:2", waiting),
    ];
    assert_eq!(fold_turn_reply_segments(&mut segments), waiting);
    assert_eq!(segment_text(&segments[0]), SUMMARY);
    // Prose that only starts with a brace is not an outcome.
    assert_eq!(
        compose_turn_reply(&[SUMMARY, "{draft} is ready."]),
        format!("{SUMMARY}\n\n{{draft}} is ready.")
    );
}

#[test]
fn earlier_segments_fold_into_the_last_text_segment() {
    let mut segments = vec![
        text("text:0", ""),
        tool("github_notifications"),
        tool("search_sessions"),
        text("text:3", "Checking Slack:"),
        tool("local_app"),
        text("text:5", SUMMARY),
        tool("reach_out"),
        text("text:7", FINAL),
    ];
    let reply = fold_turn_reply_segments(&mut segments);
    assert_eq!(reply, format!("{SUMMARY}\n\n{FINAL}"));
    assert_eq!(segment_text(&segments[3]), "Checking Slack:");
    assert_eq!(segment_text(&segments[5]), "");
    assert_eq!(segment_text(&segments[7]), reply);
    // A changed segment gets a newer revision so a live merge keeps it.
    assert!(matches!(segments[5], TurnSegment::Text { revision: 2, .. }));
    assert!(matches!(segments[7], TurnSegment::Text { revision: 2, .. }));
    assert!(matches!(segments[3], TurnSegment::Text { revision: 1, .. }));
}

#[test]
fn a_turn_that_ends_on_a_tool_keeps_its_last_text_as_the_reply() {
    let mut segments = vec![text("text:0", SUMMARY), tool("reach_out")];
    assert_eq!(fold_turn_reply_segments(&mut segments), SUMMARY);
    assert_eq!(segment_text(&segments[0]), SUMMARY);
    assert!(fold_turn_reply_segments(&mut [tool("read")]).is_empty());
}

#[test]
fn assistant_text_parts_skip_reasoning_tools_and_other_roles() {
    let messages = vec![
        json!({"role": "assistant", "content": [
            {"type": "thinking", "thinking": "Need GitHub first."},
            {"type": "toolCall", "id": "call-1", "name": "github_notifications", "arguments": {}}
        ]}),
        json!({"role": "toolResult", "content": [{"type": "text", "text": "50 notifications"}]}),
        json!({"role": "assistant", "content": [
            {"type": "text", "text": SUMMARY, "textSignature": "{\"phase\":\"commentary\"}"},
            {"type": "toolCall", "id": "call-2", "name": "reach_out", "arguments": {}}
        ]}),
        json!({"role": "toolResult", "content": [{"type": "text", "text": "failed"}]}),
        json!({"role": "assistant", "content": [{"type": "text", "text": FINAL}]}),
    ];
    let parts = assistant_text_parts(&messages);
    // The first message wrote no text, so it adds one empty part.
    assert_eq!(
        parts,
        vec![String::new(), SUMMARY.to_string(), FINAL.to_string()]
    );
    assert_eq!(compose_turn_reply(&parts), format!("{SUMMARY}\n\n{FINAL}"));
}

#[test]
fn a_preamble_before_a_tool_call_is_never_the_final_answer() {
    // "Creating the brief now…", a tool call, then a message without text.
    let messages = vec![
        json!({"role": "assistant", "content": [
            {"type": "text", "text": "Creating the brief now…"},
            {"type": "toolCall", "id": "call-1", "name": "create_document", "arguments": {}}
        ]}),
        json!({"role": "toolResult", "content": [{"type": "text", "text": "created"}]}),
        json!({"role": "assistant", "content": []}),
    ];
    let parts = assistant_text_parts(&messages);
    assert_eq!(compose_turn_reply(&parts), "");
    // Earlier substantive text is the reply instead.
    assert_eq!(
        compose_turn_reply(&[SUMMARY, "Opening Slack…", ""]),
        SUMMARY
    );
    // As the turn's last text, a preamble is still the reply.
    assert_eq!(compose_turn_reply(&["Opening Slack…"]), "Opening Slack…");

    let mut segments = vec![
        text("text:0", "Creating the brief now…"),
        tool("create_document"),
    ];
    assert_eq!(fold_turn_reply_segments(&mut segments), "");
    assert_eq!(segment_text(&segments[0]), "Creating the brief now…");

    // Clients show the last text segment as the reply, so the reply replaces
    // the trailing preamble there.
    let mut segments = vec![
        text("text:0", SUMMARY),
        tool("github_notifications"),
        text("text:2", "Checking Slack…"),
        tool("local_app"),
    ];
    assert_eq!(fold_turn_reply_segments(&mut segments), SUMMARY);
    assert_eq!(segment_text(&segments[0]), "");
    assert_eq!(segment_text(&segments[2]), SUMMARY);
}

#[test]
fn a_fenced_json_outcome_stays_alone() {
    let fenced = "```json\n{\"agentExchangeOutcome\":\"waiting\"}\n```";
    assert_eq!(compose_turn_reply(&[SUMMARY, fenced]), fenced);
    let bare_fence = "```\n{\"agentExchangeOutcome\":\"waiting\"}\n```";
    assert_eq!(compose_turn_reply(&[SUMMARY, bare_fence]), bare_fence);
    // A fence with prose around it, or a list, is not an outcome.
    let prose = "Here it is:\n```json\n{\"a\":1}\n```";
    assert_eq!(
        compose_turn_reply(&[SUMMARY, prose]),
        format!("{SUMMARY}\n\n{prose}")
    );
    let list = "```json\n[1, 2]\n```";
    assert_eq!(
        compose_turn_reply(&[SUMMARY, list]),
        format!("{SUMMARY}\n\n{list}")
    );
}
