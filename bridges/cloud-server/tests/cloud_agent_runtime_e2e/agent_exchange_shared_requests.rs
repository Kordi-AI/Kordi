//! A request from someone other than the agent's owner may ask only that
//! person back, and every shared run knows who is in the conversation.
use super::*;

#[tokio::test]
async fn another_persons_request_may_ask_only_that_person_and_resumes_on_their_reply() {
    let Some(f) = Fixture::requested_by(true, 1).await else {
        return;
    };
    let capabilities = f.capabilities().await;
    assert_eq!(
        capabilities["targets"],
        json!([]),
        "no agents for a shared request"
    );
    let people = capabilities["people"].as_array().unwrap();
    assert_eq!(people.len(), 1, "{capabilities}");
    assert_eq!(people[0]["accountId"], f.people[1].account_id.as_str());
    assert_eq!(people[0]["requester"], true);

    // Nobody but the requester: not another member, not an agent.
    assert_ne!(
        f.ask("gamma", 2, "Are you coming?").await.status(),
        StatusCode::OK
    );
    let agent = f.router.clone().oneshot(post_json_with_token(
        &format!("/v1/cloud/agent-runs/desktop/{}/agent-exchange", f.root),
        &f.people[0].token,
        json!({"claimId":f.claim,"toolCallId":"agent","arguments":{"target":format!("cloud-agent:{}",f.people[2].account_id),"targetKind":"agent","message":"Check the calendar"}}),
    )).await.unwrap();
    assert_ne!(agent.status(), StatusCode::OK);
    let untyped = f.router.clone().oneshot(post_json_with_token(
        &format!("/v1/cloud/agent-runs/desktop/{}/agent-exchange", f.root),
        &f.people[0].token,
        json!({"claimId":f.claim,"toolCallId":"untyped","arguments":{"target":format!("cloud-agent:{}",f.people[1].account_id),"message":"Check the calendar"}}),
    )).await.unwrap();
    assert_ne!(
        untyped.status(),
        StatusCode::OK,
        "not even the requester's agent"
    );
    // The owner's calendar stays out of a shared request.
    let calendar = f
        .router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{}/context", f.root),
            &f.people[0].token,
            json!({"claimId":f.claim,"tool":"read_calendar","arguments":{}}),
        ))
        .await
        .unwrap();
    assert_ne!(calendar.status(), StatusCode::OK);

    let receipt = f.ask_ok("ask-requester", 1, "What time on Friday?").await;
    let wire = f.question_wire(&receipt["exchangeId"]).await;
    let metadata = &wire["message"]["structuredContent"];
    assert!(wire["message"]["text"]
        .as_str()
        .unwrap()
        .starts_with("@ExchangeBeta What time"));
    assert_eq!(metadata["agentExchangeWaitingFor"], "Exchange Beta");
    assert_eq!(
        metadata["agentExchangeWaitingForAccountId"],
        f.people[1].account_id.as_str()
    );
    assert!(
        metadata.get("agentExchangeWaitingForRequester").is_none(),
        "older clients read that flag as the owner's own question"
    );
    let (count,): (i64,) =
        query_as("SELECT count(*) FROM cloud_agent_exchanges WHERE parent_run_id=$1")
            .bind(&f.root)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
    f.end_parent().await;

    f.say(2, "I can do 8pm", None).await;
    assert_eq!(f.exchange(&receipt["exchangeId"]).await.0, "pending");
    f.say(1, "7pm, anything is fine", None).await;
    let (status, text, _) = f.exchange(&receipt["exchangeId"]).await;
    assert_eq!(status, "reply_received");
    assert_eq!(text.as_deref(), Some("7pm, anything is fine"));
    let resume = f.pending(0).await.remove(0);
    assert_eq!(
        resume["requesterAccountId"],
        f.people[1].account_id.as_str()
    );
    let resumed = data(&resume);
    assert_eq!(resumed["personIsRequester"], true);
    assert_eq!(resumed["personReply"], "7pm, anything is fine");
    assert_eq!(resumed["remainingRequests"], 7);

    // The continuation keeps the requester's identity and restrictions.
    let claim = f.claim(0, &resume).await;
    let run = resume["runId"].as_str().unwrap();
    let capabilities = f
        .post(
            0,
            &format!("/v1/cloud/agent-runs/desktop/{run}/agent-exchange"),
            json!({"claimId":claim,"action":"capabilities"}),
        )
        .await;
    assert_eq!(capabilities["targets"], json!([]));
    assert_eq!(capabilities["people"].as_array().unwrap().len(), 1);
    f.finish(0, run, claim, "Booked a table for 7pm on Friday.")
        .await;
    assert_eq!(f.exchange(&receipt["exchangeId"]).await.0, "completed");
}

#[tokio::test]
async fn a_shared_request_in_a_direct_chat_asks_without_a_mention_and_answers_go_to_its_agent() {
    let Some(f) = Fixture::requested_by(false, 1).await else {
        return;
    };
    let receipt = f.ask_ok("ask-requester", 1, "Which city?").await;
    let wire = f.question_wire(&receipt["exchangeId"]).await;
    assert_eq!(wire["text"], "Which city?");
    assert_eq!(
        wire["agentExchangeWaitingForAccountId"],
        f.people[1].account_id.as_str()
    );
    f.end_parent().await;
    // A new request from the requester to the same agent supersedes the question.
    let owner = &f.people[0].account_id;
    f.say(
        1,
        &agent_request("Plan lunch instead", &format!("cloud-agent:{owner}"), owner),
        None,
    )
    .await;
    assert_eq!(f.exchange(&receipt["exchangeId"]).await.0, "cancelled");
    assert!(f.pending(0).await.is_empty());
}

#[tokio::test]
async fn an_answering_agent_asks_its_owner_and_its_answer_returns_to_the_asking_agent() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let sent = f.send("ask-beta-agent", 1).await;
    let exchange = sent["exchangeId"].clone();
    let target = f.pending(1).await.remove(0);
    let run = target["runId"].as_str().unwrap().to_owned();
    let claim = f.claim(1, &target).await;
    let path = format!("/v1/cloud/agent-runs/desktop/{run}/agent-exchange");
    let capabilities = f
        .post(1, &path, json!({"claimId":claim,"action":"capabilities"}))
        .await;
    assert_eq!(capabilities["targets"], json!([]));
    let people = capabilities["people"].as_array().unwrap();
    assert_eq!(people.len(), 1, "only its own owner: {capabilities}");
    assert_eq!(people[0]["accountId"], f.people[1].account_id.as_str());
    for (key, who) in [("requester", 0), ("other", 2)] {
        let refused = f.router.clone().oneshot(post_json_with_token(&path, &f.people[1].token,
            json!({"claimId":claim,"toolCallId":key,"arguments":{"target":f.people[who].account_id,"targetKind":"person","message":"When?"}}))).await.unwrap();
        assert_ne!(refused.status(), StatusCode::OK, "{key}");
    }
    let asked = f.post(1, &path, json!({"claimId":claim,"toolCallId":"owner","arguments":{"target":f.people[1].account_id,"targetKind":"person","message":"Alpha's agent asks when you are free on Friday. OK to share?"}})).await;
    // The asking agent's request waits for Beta, as long as Beta's question.
    let (deadline,): (bool,) = query_as("SELECT deadline_at>now()+interval '23 hours' FROM cloud_agent_exchanges WHERE exchange_id=$1::uuid")
        .bind(exchange.as_str().unwrap()).fetch_one(&f.pool).await.unwrap();
    assert!(deadline);
    let wire = f.question_wire(&exchange).await;
    assert_eq!(
        wire["message"]["structuredContent"]["agentExchangeWaitingFor"],
        "Exchange Beta"
    );
    f.finish(1, &run, claim, r#"{"agentExchangeOutcome":"waiting"}"#)
        .await;
    assert_eq!(f.exchange(&exchange).await.0, "pending", "no reply yet");
    f.end_parent().await;

    f.say(1, "Friday after 7pm, fine to share", None).await;
    assert_eq!(f.exchange(&asked["exchangeId"]).await.0, "reply_received");
    let resume = f.pending(1).await.remove(0);
    assert_eq!(
        resume["requesterAccountId"],
        f.people[0].account_id.as_str()
    );
    let resumed = data(&resume);
    assert_eq!(resumed["answeringAgentRequest"], true);
    assert_eq!(resumed["originalRequest"], "Return the synthetic status.");
    assert_eq!(resumed["personReply"], "Friday after 7pm, fine to share");
    let resume_run = resume["runId"].as_str().unwrap();
    let claim = f.claim(1, &resume).await;
    f.finish(1, resume_run, claim, "Beta is free on Friday after 7pm.")
        .await;
    let (status, text, _) = f.exchange(&exchange).await;
    assert_eq!(status, "reply_received");
    assert_eq!(text.as_deref(), Some("Beta is free on Friday after 7pm."));
    assert_eq!(f.exchange(&asked["exchangeId"]).await.0, "completed");
    // The asking agent continues as usual, and knows whom to ask next.
    let continued = data(&f.pending(0).await.remove(0));
    assert_eq!(continued["agentReply"], "Beta is free on Friday after 7pm.");
    assert_eq!(
        continued["agentOwner"]["accountId"],
        f.people[1].account_id.as_str()
    );
}
