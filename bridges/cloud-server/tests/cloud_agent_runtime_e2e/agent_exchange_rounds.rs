//! An owner can ask two agents to keep talking. Each continuation may send one
//! more request carrying the earlier rounds, within the per-task limit.
use super::*;
use base64::Engine;
use sqlx_core::query_as::query_as;
const WAITING: &str = r#"{"agentExchangeOutcome":"waiting"}"#;

impl Fixture {
    /// Answers the single pending request to `person` and returns the resume run.
    async fn answer(&self, person: usize, reply: &str) -> Value {
        let target = self.pending(person).await.remove(0);
        let claim = self.claim(person, &target).await;
        self.finish(person, target["runId"].as_str().unwrap(), claim, reply)
            .await;
        self.pending(0).await.remove(0)
    }
    async fn send_text(&self, key: &str, target: usize, message: &str) -> Value {
        self.post(0,&format!("/v1/cloud/agent-runs/desktop/{}/agent-exchange",self.root),json!({"claimId":self.claim,"toolCallId":key,"arguments":{"target":format!("cloud-agent:{}",self.people[target].account_id),"message":message}})).await
    }
}

fn data(run: &Value) -> Value {
    let prompt = run["prompt"].as_str().unwrap();
    serde_json::from_str(prompt.split_once('\n').unwrap().1).unwrap()
}

#[tokio::test]
async fn a_continuation_keeps_the_discussion_going_with_earlier_rounds() {
    let Some(mut f) = Fixture::new().await else {
        return;
    };
    f.send_text("round-1", 1, "Opening question").await;
    f.end_parent().await;
    let resume = f.answer(1, "First answer").await;
    let first = data(&resume);
    assert_eq!(first["remainingRequests"], 7);
    assert_eq!(first["earlierRounds"], json!([]));
    assert!(resume["prompt"]
        .as_str()
        .unwrap()
        .contains("use reach_out to send the same agent one new message"));

    // The continuation answers back instead of ending the discussion.
    let claim = f.claim(0, &resume).await;
    let run = resume["runId"].as_str().unwrap().to_owned();
    f.root = run.clone();
    f.claim = claim;
    f.send_text("round-2", 1, "Second point").await;
    let target = f.pending(1).await.remove(0);
    let recipient = data(&target);
    assert_eq!(recipient["newRequest"], "Second point");
    assert_eq!(
        recipient["earlierRounds"][0]["sentRequest"],
        "Opening question"
    );
    assert_eq!(recipient["earlierRounds"][0]["agentReply"], "First answer");
    f.finish(0, &run, claim, WAITING).await;

    let resume = f.answer(1, "Second answer").await;
    let second = data(&resume);
    assert_eq!(second["remainingRequests"], 6);
    assert_eq!(second["sentRequest"], "Second point");
    assert_eq!(second["agentReply"], "Second answer");
    assert_eq!(second["earlierRounds"][0]["agentReply"], "First answer");
    assert_eq!(second["originalRequest"], "Ask Beta and continue");
}

#[tokio::test]
async fn a_discussion_stops_at_the_task_limit() {
    let Some(mut f) = Fixture::new().await else {
        return;
    };
    for round in 0..8i64 {
        f.send_text(&format!("round-{round}"), 1, &format!("Point {round}"))
            .await;
        if round == 0 {
            f.end_parent().await;
        } else {
            let run = f.root.clone();
            f.finish(0, &run, f.claim, WAITING).await;
        }
        let resume = f.answer(1, &format!("Answer {round}")).await;
        let resumed = data(&resume);
        assert_eq!(resumed["remainingRequests"], 7 - round);
        assert!(resume["prompt"]
            .as_str()
            .unwrap()
            .contains("always publish a short closing summary"));
        assert!(resumed["earlierRounds"].as_array().unwrap().len() <= 6);
        f.claim = f.claim(0, &resume).await;
        f.root = resume["runId"].as_str().unwrap().into();
    }
    // The last continuation cannot send another request.
    let response = f
        .router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{}/agent-exchange", f.root),
            &f.people[0].token,
            json!({"claimId":f.claim,"toolCallId":"round-8","arguments":{"target":format!("cloud-agent:{}",f.people[1].account_id),"message":"One more"}}),
        ))
        .await
        .unwrap();
    assert_ne!(response.status(), StatusCode::OK);
    // The final continuation closes the discussion with a visible summary.
    let summary = "We agreed on a shared baseline.\nOpen: merge order.";
    let run = f.root.clone();
    f.finish(0, &run, f.claim, summary).await;
    let (body,): (String,) = query_as("SELECT m.content #>> '{blocks,0,text}' FROM cloud_agent_fallback_runs r JOIN cloud_chat_messages m ON m.message_id::text=r.response_message_id WHERE r.run_id=$1")
        .bind(&run).fetch_one(&f.pool).await.unwrap();
    let wire: Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(body.split_once(':').unwrap().1)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(wire["message"]["text"], summary);
}
