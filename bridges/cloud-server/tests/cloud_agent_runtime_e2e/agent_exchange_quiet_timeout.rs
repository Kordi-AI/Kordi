//! Deadline recovery preserves prior results and fences late replies.
use super::*;

#[tokio::test]
async fn exchange_timeout_resumes_with_the_missing_reply_skipped() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    f.send("call", 2).await;
    let recipient = f.pending(2).await.remove(0);
    let run = recipient["runId"].as_str().unwrap();
    let claim = f.claim(2, &recipient).await;
    query("UPDATE cloud_agent_exchanges SET deadline_at=now()-interval '1 second' WHERE parent_run_id=$1").bind(&f.root).execute(&f.pool).await.unwrap();
    // The deadline also fences a late answer that arrives before the sweep.
    let late = f
        .router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-exchanges/desktop/{run}/complete"),
            &f.people[2].token,
            json!({"claimId":claim,"text":"A late answer"}),
        ))
        .await
        .unwrap();
    assert_ne!(late.status(), StatusCode::OK);
    assert!(f.pending(0).await.is_empty());
    assert_eq!(f.question_progress().await.0, "processing");
    f.end_parent().await;
    let resume = f.pending(0).await.remove(0);
    let (rules, context) = resume["prompt"].as_str().unwrap().split_once('\n').unwrap();
    let data: Value = serde_json::from_str(context).unwrap();
    assert!(rules.contains("Skip the missing input"));
    assert!(data["agentReply"].is_null());
    assert_eq!(data["remainingRequests"], 0);
    assert!(f.pending(2).await.is_empty());
}

#[tokio::test]
async fn a_timeout_can_finish_quietly_and_preserve_the_earlier_result() {
    let Some(mut f) = Fixture::new().await else {
        return;
    };
    let root = f.root.clone();
    f.send("compute", 1).await;
    f.complete_parent(false).await;
    let target = f.pending(1).await.remove(0);
    let claim = f.claim(1, &target).await;
    f.finish(
        1,
        target["runId"].as_str().unwrap(),
        claim,
        "The confirmed total is 15.",
    )
    .await;
    let follow_up = f.pending(0).await.remove(0);
    f.claim = f.claim(0, &follow_up).await;
    f.root = follow_up["runId"].as_str().unwrap().into();
    f.send("second-opinion", 2).await;
    f.finish(0, &f.root, f.claim, WAITING).await;
    let prior_results = f.public_texts().await;
    assert!(prior_results
        .iter()
        .any(|text| text == "The confirmed total is 15."));

    query("UPDATE cloud_agent_exchanges SET deadline_at=now()-interval '1 second' WHERE parent_run_id=$1").bind(&f.root).execute(&f.pool).await.unwrap();
    let resume = f.pending(0).await.remove(0);
    let (rules, context) = resume["prompt"].as_str().unwrap().split_once('\n').unwrap();
    let data: Value = serde_json::from_str(context).unwrap();
    assert!(rules.contains("Skip the missing input"));
    assert!(data["agentReply"].is_null());
    assert_eq!(
        data["earlierRounds"][0]["agentReply"],
        "The confirmed total is 15."
    );
    assert_eq!(data["remainingRequests"], 0);
    let (_, _, retired) = f.recipient_row().await;
    assert_eq!(retired["deliveryState"], "cancelled");
    assert_eq!(retired["structuredContent"]["synchronizationOnly"], true);
    let run = resume["runId"].as_str().unwrap();
    let claim = f.claim(0, &resume).await;
    let response = f
        .router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{run}/agent-exchange"),
            &f.people[0].token,
            json!({"claimId":claim,"toolCallId":"try-again","arguments":{"target":format!("cloud-agent:{}",f.people[2].account_id),"message":"Any updates?"}}),
        ))
        .await
        .unwrap();
    assert_ne!(response.status(), StatusCode::OK);
    f.finish(0, run, claim, SILENT).await;
    assert_eq!(f.slot(&root).await.1["synchronizationOnly"], true);
    assert_eq!(f.public_texts().await, prior_results);
}
