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
    // Another person's request, including an agent-to-agent request, never reaches the server.
    let client = RecordingClient::default();
    let provider = FakeProvider::new(vec![
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "calendar".into(),
            name: "read_calendar".into(),
            arguments: json!({}),
        }]),
        ModelProviderResponse::FinalText("Declined".into()),
    ]);
    run_model_loop(
        &client,
        &provider,
        &run(),
        &sandbox_handle(),
        provider_auth(),
    )
    .await
    .unwrap();
    assert!(client.calendar_arguments.lock().unwrap().is_empty());
}
