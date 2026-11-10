use super::*;

/// Conversations whose evaluation fails, as a broken read would.
static BROKEN: std::sync::Mutex<Vec<Uuid>> = std::sync::Mutex::new(Vec::new());

pub(in crate::system_agent) fn break_conversation(conversation_id: Uuid) {
    BROKEN.lock().unwrap().push(conversation_id);
}

pub(super) fn fail_if_broken(conversation_id: Uuid) -> Result<(), sqlx_core::Error> {
    if BROKEN.lock().unwrap().contains(&conversation_id) {
        return Err(sqlx_core::Error::Protocol("a broken conversation".into()));
    }
    Ok(())
}

#[test]
fn run_output_accepts_json_and_bare_text() {
    let json =
        parse_run_output(r#"{"message":"Lunch card is up.","hooksHandled":["t_minus_24h"]}"#);
    assert_eq!(json.message.as_deref(), Some("Lunch card is up."));
    assert_eq!(json.hooks_handled, vec!["t_minus_24h".to_string()]);
    let silent = parse_run_output(r#"{"message":null,"hooksHandled":[]}"#);
    assert!(silent.message.is_none());
    let bare = parse_run_output("Still on for tomorrow?");
    assert_eq!(bare.message.as_deref(), Some("Still on for tomorrow?"));
    assert!(parse_run_output("   ").message.is_none());
}

#[test]
fn offered_reminders_fire_even_when_the_run_stays_silent() {
    let input = json!({"hooks": [
        {"name": "new_messages", "sinceSequence": 4},
        {"name": "t_minus_24h", "key": "t_minus_24h:plan_a", "eventId": "plan_a"},
        {"name": "card_changed", "eventId": "plan_a", "revision": 3},
    ]});
    assert_eq!(
        offered_reminders(&input),
        json!({"t_minus_24h:plan_a": true})
    );
    assert_eq!(offered_reminders(&json!({"hooks": []})), json!({}));
}
