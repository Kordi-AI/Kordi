//! The current request decides the reply's language: Chinese history, owner
//! memories, or a Chinese answer never turn an English request into a
//! Chinese reply, on first turns and on resumed runs.
use super::*;

async fn context(f: &Fixture, run: &str) -> String {
    let (identity,): (Option<Value>,) =
        query_as("SELECT turn_identity FROM cloud_agent_fallback_runs WHERE run_id=$1")
            .bind(run)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    identity.expect("identity")["conversationContext"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn an_english_request_after_chinese_history_is_answered_in_english() {
    let Some(f) = Fixture::kind(false).await else {
        return;
    };
    let owner = f.people[0].account_id.clone();
    f.say(
        0,
        "\u{6211}\u{4eec}\u{5468}\u{672b}\u{53bb}\u{722c}\u{5c71}\u{5427}",
        None,
    )
    .await;
    f.say(
        1,
        "\u{597d}\u{7684}\u{ff0c}\u{5468}\u{516d}\u{53ef}\u{4ee5}",
        None,
    )
    .await;
    let text = "find a time for a 1-hour call on Saturday";
    let agent = format!("cloud-agent:{owner}");
    let wire = f
        .say(1, &agent_request(text, &agent, &owner), None)
        .await
        .to_string();
    let requester = f.people[1].account_id.clone();
    let body = json!({"requestMessageId":wire,"sessionId":f.session,"ownerAccountId":owner,"requesterAccountId":requester,"prompt":text,"idempotencyKey":format!("shared:{wire}:{owner}")});
    let run = f.post(1, "/v1/cloud/agent-runs/claim", body).await["runId"]
        .as_str()
        .unwrap()
        .to_owned();
    let first = context(&f, &run).await;
    assert!(
        first.contains("not in Chinese, Japanese, or Korean"),
        "{first}"
    );

    // The person answers in Chinese; the resumed run still follows the request.
    f.ask_ok("ask", 1, "Which hour on Saturday works?").await;
    f.end_parent().await;
    f.say(
        1,
        "\u{5468}\u{516d}\u{4e0b}\u{5348}\u{4e09}\u{70b9}\u{53ef}\u{4ee5}",
        None,
    )
    .await;
    let resume = f.pending(0).await.remove(0);
    f.claim(0, &resume).await;
    let resumed = context(&f, resume["runId"].as_str().unwrap()).await;
    assert!(
        resumed.contains("not in Chinese, Japanese, or Korean"),
        "{resumed}"
    );

    // A Chinese request names Chinese.
    let wire = f
        .say(
            1,
            &agent_request(
                "\u{5e2e}\u{6211}\u{7ea6}\u{5468}\u{65e5}\u{7684}\u{65f6}\u{95f4}",
                &agent,
                &owner,
            ),
            None,
        )
        .await
        .to_string();
    let body = json!({"requestMessageId":wire,"sessionId":f.session,"ownerAccountId":owner,"requesterAccountId":requester,"prompt":"\u{5e2e}\u{6211}\u{7ea6}\u{5468}\u{65e5}\u{7684}\u{65f6}\u{95f4}","idempotencyKey":format!("shared:{wire}:{owner}")});
    let run = f.post(1, "/v1/cloud/agent-runs/claim", body).await["runId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(context(&f, &run)
        .await
        .ends_with("The current request is in Chinese."));
}
