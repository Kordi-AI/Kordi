use super::*;

fn row(id: &str, value: serde_json::Value) -> (String, String, String, String) {
    let body = format!(
        "kordi-cloud-message:{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap())
    );
    (
        id.to_string(),
        format!("client-{id}"),
        "acct_owner".to_string(),
        body,
    )
}

#[test]
fn fallback_context_isolated_by_thread_before_history_limit() {
    let action = serde_json::json!({"kind":"thread","source":{"sourceMessageId":"root"}});
    let rows = vec![
        row("root", serde_json::json!({"kind":"message","text":"Root"})),
        row(
            "child-request",
            serde_json::json!({"kind":"message","text":"Thread request","messageAction":action}),
        ),
        row(
            "child-result",
            serde_json::json!({"kind":"agent-response","requestId":"child-request","text":"THREAD_ONLY"}),
        ),
        row(
            "main",
            serde_json::json!({"kind":"message","text":"Main request"}),
        ),
        row(
            "followup",
            serde_json::json!({"kind":"message","text":"Continue","messageAction":action}),
        ),
    ];
    assert_eq!(
        context_history_indices(&rows, "main", None),
        (Some(3), vec![0])
    );
    assert_eq!(
        context_history_indices(&rows, "followup", None),
        (Some(4), vec![0, 1, 2])
    );
    assert_eq!(
        context_history_indices(&rows, "ios_client-main", None),
        (Some(3), vec![0])
    );
}

#[test]
fn orphan_responses_and_forwarded_context_fail_closed() {
    let rows = vec![
        row(
            "orphan",
            serde_json::json!({"kind":"agent-response","requestId":"older-thread-request","text":"PRIVATE_THREAD"}),
        ),
        row(
            "forward",
            serde_json::json!({"kind":"message","text":"FORWARD","messageAction":{"kind":"forward"}}),
        ),
        row(
            "main",
            serde_json::json!({"kind":"message","text":"Main request"}),
        ),
    ];
    assert_eq!(
        context_history_indices(&rows, "main", None),
        (Some(2), vec![])
    );
}

fn group_line(sender: &str, kind: Option<&str>, text: &str) -> CloudFallbackHistoryMessage {
    let mut message = serde_json::json!({"id":format!("m-{text}"),"senderAccountId":sender,"text":text,"createdAtMs":1});
    if let Some(kind) = kind {
        message["senderKind"] = kind.into();
        message["senderOwnerAccountId"] = sender.into();
    }
    let envelope = serde_json::json!({"kind":"group-message","groupId":"session:group:g","createdByAccountId":sender,
        "actor":{"accountId":sender,"displayName":"Synthetic"},"participants":[],"message":message});
    CloudFallbackHistoryMessage {
        from_account_id: sender.to_string(),
        body: format!(
            "kordi-cloud-group:{}",
            URL_SAFE_NO_PAD.encode(envelope.to_string())
        ),
    }
}

#[test]
fn agent_replies_are_never_labelled_as_their_owner_person() {
    let history = [
        group_line("acct_requester", None, "@Kordi what is 2 + 2?"),
        group_line("acct_requester", Some("agent"), "2 + 2 = 4."),
        group_line(
            "acct_owner",
            Some("agent"),
            "@KordiRequester owner agent reply",
        ),
        group_line("acct_other", Some("agent"), "third agent reply"),
        CloudFallbackHistoryMessage {
            from_account_id: "acct_requester".to_string(),
            body: crate::cloud_agent_runtime::runs::envelopes::encode_cloud_agent_response_body(
                "request",
                "direct reply from the requester's agent",
            ),
        },
    ];
    let prompt = fallback_prompt_with_history("acct_requester", "acct_owner", "next", &history);
    let lines: Vec<_> = prompt.lines().skip(1).take(5).collect();
    assert_eq!(
        lines,
        [
            "Requester: what is 2 + 2?",
            "Requester's agent: 2 + 2 = 4.",
            "Owner agent: @KordiRequester owner agent reply",
            "Participant's agent: third agent reply",
            "Requester's agent: direct reply from the requester's agent",
        ]
    );
}
