use super::*;

#[tokio::test]
async fn calendar_tool_retrieves_saved_events_and_distinguishes_empty_and_denied_access() {
    assert!(tool_catalog()
        .iter()
        .any(|tool| tool["function"]["name"] == "read_calendar"));
    for (value, own_request) in [
        (
            Some(
                json!({"status":"ready","events":[{"title":"Saved appointment","status":"saved"}]}),
            ),
            true,
        ),
        (Some(json!({"status":"empty","events":[]})), true),
        (None, true),
        (
            Some(json!({"events":[{"title":"Must stay private"}]})),
            false,
        ),
    ] {
        let client = RecordingClient {
            calendar: value.clone(),
            ..Default::default()
        };
        let provider = FakeProvider::new(vec![
            ModelProviderResponse::ToolCalls(vec![ModelToolCall {
                id: "calendar".into(),
                name: "read_calendar".into(),
                arguments: json!({"shareInConversation":true}),
            }]),
            ModelProviderResponse::FinalText("Calendar checked".into()),
        ]);
        let mut run = run();
        if own_request {
            run.requester_account_id = run.owner_account_id.clone();
        }
        run_model_loop(&client, &provider, &run, &sandbox_handle(), provider_auth())
            .await
            .unwrap();
        let messages = provider.seen_messages.lock().unwrap();
        let result = messages[1].last().unwrap()["content"].as_str().unwrap();
        if let (true, Some(expected)) = (own_request, value) {
            assert_eq!(serde_json::from_str::<Value>(result).unwrap(), expected);
        } else {
            assert!(result.contains("not an empty calendar"));
            assert!(!result.contains("Must stay private"));
        }
    }
}

#[tokio::test]
async fn owner_requested_shared_calendar_reads_default_to_availability_only() {
    let windows = json!({"status":"ready","disclosure":"availability","busyWindows":[{"startAt":"2026-09-11T18:00:00Z","busy":true}]});
    for (arguments, expected_disclosure) in [
        (json!({}), Some("availability")),
        (json!({"shareInConversation":false}), Some("availability")),
        (json!({"shareInConversation":true}), None),
    ] {
        let client = RecordingClient {
            calendar: Some(windows.clone()),
            ..Default::default()
        };
        let provider = FakeProvider::new(vec![
            ModelProviderResponse::ToolCalls(vec![ModelToolCall {
                id: "calendar".into(),
                name: "read_calendar".into(),
                arguments,
            }]),
            ModelProviderResponse::FinalText("Planned".into()),
        ]);
        let mut run = run();
        run.requester_account_id = run.owner_account_id.clone();
        run_model_loop(&client, &provider, &run, &sandbox_handle(), provider_auth())
            .await
            .unwrap();
        let sent = client.calendar_arguments.lock().unwrap();
        assert_eq!(
            sent.len(),
            1,
            "the owner's shared read must reach the server"
        );
        assert_eq!(sent[0]["disclosure"].as_str(), expected_disclosure);
        let messages = provider.seen_messages.lock().unwrap();
        let result = messages[1].last().unwrap()["content"].as_str().unwrap();
        assert_eq!(serde_json::from_str::<Value>(result).unwrap(), windows);
    }
}

/// Sends one `read_calendar` call for `run` and returns the arguments that
/// reached the server, if any.
async fn sent_calendar_arguments(run: &CloudAgentRun, arguments: Value) -> Option<Value> {
    let client = RecordingClient {
        calendar: Some(json!({"status":"empty","disclosure":"availability","busyWindows":[]})),
        ..Default::default()
    };
    let provider = FakeProvider::new(vec![
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "calendar".into(),
            name: "read_calendar".into(),
            arguments,
        }]),
        ModelProviderResponse::FinalText("Answered".into()),
    ]);
    run_model_loop(&client, &provider, run, &sandbox_handle(), provider_auth())
        .await
        .unwrap();
    let sent = client.calendar_arguments.lock().unwrap().clone();
    assert!(sent.len() <= 1);
    sent.into_iter().next()
}

#[tokio::test]
async fn another_members_request_reads_only_the_owners_availability_in_a_shared_chat() {
    // Another member (or their agent) asks the owner's agent: availability only.
    let sent = sent_calendar_arguments(&run(), json!({})).await.unwrap();
    assert_eq!(sent["disclosure"], "availability");
    for details in [
        json!({"shareInConversation":true}),
        json!({"disclosure":"details"}),
    ] {
        assert!(sent_calendar_arguments(&run(), details).await.is_none());
    }
    // Outside a shared conversation, and in execution subsessions, nothing is read.
    let mut private = run();
    private.session_id = "session:self-agent:owner".into();
    assert!(sent_calendar_arguments(&private, json!({})).await.is_none());
    let mut child = run();
    child.requester_account_id = child.owner_account_id.clone();
    child.subsession_id = Some("child".into());
    assert!(sent_calendar_arguments(&child, json!({})).await.is_none());
}
