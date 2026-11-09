//! A request from someone other than the agent's owner may ask only that
//! person back, and every shared run knows who is in the conversation.
use super::*;

/// The JSON line of a turn identity's conversation context.
fn context_of(identity: &Value) -> Value {
    let text = identity["conversationContext"].as_str().expect("context");
    assert!(text.contains("untrusted"), "{text}");
    serde_json::from_str(text.lines().nth(1).unwrap()).unwrap()
}

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
async fn a_shared_run_knows_the_members_their_profiles_and_the_time() {
    let Some(f) = Fixture::requested_by(true, 1).await else {
        return;
    };
    let context = context_of(&f.identity);
    assert_eq!(context["conversation"]["kind"], "group");
    let people = context["people"].as_array().unwrap();
    assert_eq!(people.len(), 3, "{context}");
    let alpha = people
        .iter()
        .find(|p| p["participantId"] == f.people[0].account_id.as_str())
        .unwrap();
    let beta = people
        .iter()
        .find(|p| p["participantId"] == f.people[1].account_id.as_str())
        .unwrap();
    assert_eq!(alpha["isOwner"], true);
    assert_eq!(beta["isRequester"], true);
    assert_eq!(beta["handle"], "@ExchangeBeta");
    assert!(beta.get("location").is_none() && beta.get("timeZone").is_none());
    let agents = context["agents"].as_array().unwrap();
    assert!(agents.iter().any(|a| a["agentId"]
        == format!("cloud-agent:{}", f.people[0].account_id)
        && a["isYou"] == true));
    assert_eq!(context["nowTimeZone"], "UTC");

    // Profile fields set later reach the next run; a member who left does not.
    query("UPDATE cloud_accounts SET location='Synthetic City', time_zone='Asia/Shanghai' WHERE account_id=$1")
        .bind(&f.people[1].account_id).execute(&f.pool).await.unwrap();
    query("UPDATE cloud_accounts SET time_zone='America/Los_Angeles' WHERE account_id=$1")
        .bind(&f.people[0].account_id)
        .execute(&f.pool)
        .await
        .unwrap();
    query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE account_id=$1")
        .bind(&f.people[2].account_id)
        .execute(&f.pool)
        .await
        .unwrap();
    f.ask_ok("ask", 1, "Which area?").await;
    f.end_parent().await;
    f.say(1, "Downtown", None).await;
    let resume = f.pending(0).await.remove(0);
    let body = json!({"claimId":uuid::Uuid::new_v4(),"requestMessageId":resume["requestMessageId"],"sessionId":f.session,"ownerAccountId":f.people[0].account_id,"requesterAccountId":resume["requesterAccountId"],"prompt":resume["prompt"],"idempotencyKey":resume["runId"]});
    let claimed = f.post(0, "/v1/cloud/agent-runs/desktop/claim", body).await;
    let context = context_of(&claimed["turnIdentity"]);
    let people = context["people"].as_array().unwrap();
    assert_eq!(people.len(), 2, "only active members: {context}");
    let beta = people
        .iter()
        .find(|p| p["participantId"] == f.people[1].account_id.as_str())
        .unwrap();
    assert_eq!(beta["location"], "Synthetic City");
    assert_eq!(beta["timeZone"], "Asia/Shanghai");
    assert_eq!(context["nowTimeZone"], "America/Los_Angeles");
    assert!(!context.to_string().contains(&f.people[2].account_id));
}
