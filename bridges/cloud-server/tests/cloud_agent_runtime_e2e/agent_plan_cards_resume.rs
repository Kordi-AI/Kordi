//! Plan cards from the runs that continue a person's task (issue #2446): a
//! resume after another agent or a person answered plans for the task's root.
use super::agent_exchanges::Fixture;
use super::agent_plan_cards::{card_call, later, root_call};
use super::*;
use sqlx_core::{query::query, query_as::query_as};

/// The owner's task after another agent answered: the resume run continues it.
async fn resumed_task(f: &Fixture) -> Value {
    f.send("ask-beta", 1).await;
    let target = f.pending(1).await.remove(0);
    let claim = f.claim(1, &target).await;
    f.post(
        1,
        &format!(
            "/v1/cloud/agent-exchanges/desktop/{}/complete",
            target["runId"].as_str().unwrap()
        ),
        json!({"claimId": claim, "text": "Saturday 10:00 works for Beta."}),
    )
    .await;
    f.end_parent().await;
    f.pending(0).await.remove(0)
}

#[tokio::test]
async fn the_resumed_task_on_the_mac_opens_the_card_and_keeps_one_per_task() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let resume = resumed_task(&f).await;
    let run = resume["runId"].as_str().unwrap().to_string();
    assert!(run.starts_with("car_exchange_resume_"), "{run}");
    let claim = f.claim(0, &resume).await;

    let (status, created) = card_call(
        &f,
        0,
        &run,
        claim,
        "create",
        json!({"title": "Coffee chat", "startAt": later(0)}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let event_id = created["eventId"].as_str().unwrap().to_string();
    let (task,): (String,) =
        query_as("SELECT created_by_task_run_id FROM cloud_plan_cards WHERE event_id = $1")
            .bind(&event_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(task, f.root, "the card belongs to the owner's task");

    // The same task opens no second card, whichever of its runs asks.
    let (status, again) = card_call(
        &f,
        0,
        &run,
        claim,
        "create",
        json!({"title": "Coffee chat", "startAt": later(0)}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{again}");
    assert!(again["message"].as_str().unwrap().contains(&event_id));
    let (status, updated) = card_call(
        &f,
        0,
        &run,
        claim,
        "update",
        json!({"eventId": event_id, "location": "Corner cafe"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
}

#[tokio::test]
async fn a_card_the_task_opened_before_delegating_is_the_one_its_resume_updates() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let (status, created) = root_call(
        &f,
        "create",
        json!({"kind": "vote", "title": "Coffee chat", "options": [
            {"label": "Sat 10:00", "startAt": later(0)}, {"label": "Sat 14:00", "startAt": later(4)}
        ]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let resume = resumed_task(&f).await;
    let run = resume["runId"].as_str().unwrap().to_string();

    // On the cloud runner this time: the lease offers the tool.
    query("UPDATE cloud_agent_fallback_runs SET desktop_preferred_until = now() - interval '1 second' WHERE run_id = $1")
        .bind(&run)
        .execute(&f.pool)
        .await
        .unwrap();
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let lease = f
        .router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({"runnerId": "runner-plan-cards", "canaryRunId": run}),
        ))
        .await
        .unwrap();
    let lease = read_json(lease).await;
    assert_eq!(lease["run"]["runId"], run.as_str());
    assert_eq!(lease["run"]["planCards"], true, "{lease}");

    let runner_call = |action: &str, arguments: Value| {
        f.router.clone().oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run}/agent-plan-card"),
            "runner-test-token",
            json!({"runnerId": "runner-plan-cards", "toolCallId": "call", "action": action, "arguments": arguments}),
        ))
    };
    let response = runner_call(
        "create",
        json!({"title": "Coffee chat", "startAt": later(0)}),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let response = runner_call(
        "update",
        json!({"eventId": created["eventId"], "kind": "plan", "startAt": later(0), "options": []}),
    )
    .await
    .unwrap();
    let status = response.status();
    let updated = read_json(response).await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["kind"], "plan");
}

#[tokio::test]
async fn a_run_continuing_the_task_through_its_parent_plans_for_the_root() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    // A continuation linked to the owner's task by parent_run_id only, held
    // by the cloud runner (the shape of a resume after a person answers).
    let child = format!("car_continuation_{}", uuid::Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, session_id,
             owner_account_id, requester_account_id, status, prompt, created_at, updated_at,
             execution_agent_id, parent_run_id, claimed_by, lease_expires_at)
         SELECT $1, $1, $1, session_id, owner_account_id, requester_account_id, 'leased', 'continue',
                now()::text, now()::text, execution_agent_id, run_id, 'runner-continuation',
                (now() + interval '10 minutes')::text
         FROM cloud_agent_fallback_runs WHERE run_id = $2",
    )
    .bind(&child)
    .bind(&f.root)
    .execute(&f.pool)
    .await
    .unwrap();
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let call = |runner: &str, action: &str, arguments: Value| {
        f.router.clone().oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{child}/agent-plan-card"),
            "runner-test-token",
            json!({"runnerId": runner, "toolCallId": "call", "action": action, "arguments": arguments}),
        ))
    };
    // Another runner does not hold the lease.
    let refused = call("runner-other", "capabilities", json!({}))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    let response = call(
        "runner-continuation",
        "create",
        json!({"title": "Coffee chat", "startAt": later(0)}),
    )
    .await
    .unwrap();
    let status = response.status();
    let created = read_json(response).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let (task,): (String,) =
        query_as("SELECT created_by_task_run_id FROM cloud_plan_cards WHERE event_id = $1")
            .bind(created["eventId"].as_str().unwrap())
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(task, f.root);
    // The task's root run opens no second card either.
    let (status, again) = root_call(
        &f,
        "create",
        json!({"title": "Coffee", "startAt": later(0)}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{again}");
}

/// A runner lease for `run`, which must offer the card tool.
async fn runner_lease(f: &Fixture, run: &str, runner: &str) {
    query("UPDATE cloud_agent_fallback_runs SET desktop_preferred_until = now() - interval '1 second' WHERE run_id = $1")
        .bind(run)
        .execute(&f.pool)
        .await
        .unwrap();
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let lease = f
        .router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({"runnerId": runner, "canaryRunId": run}),
        ))
        .await
        .unwrap();
    let lease = read_json(lease).await;
    assert_eq!(lease["run"]["runId"], run);
    assert_eq!(lease["run"]["planCards"], true, "{lease}");
}

async fn runner_card(
    f: &Fixture,
    run: &str,
    runner: &str,
    arguments: Value,
) -> (StatusCode, Value) {
    let response = f
        .router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run}/agent-plan-card"),
            "runner-test-token",
            json!({"runnerId": runner, "toolCallId": "call", "action": arguments["action"], "arguments": arguments}),
        ))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

/// The decision step of a resumed exchange, worded as chat guidance for the
/// System agent: propose a vote, then propose the settled plan on it.
async fn decide_with_propose(
    call: impl Fn(
        Value,
    )
        -> std::pin::Pin<Box<dyn std::future::Future<Output = (StatusCode, Value)> + Send>>,
    root: &str,
    pool: &sqlx_postgres::PgPool,
) {
    let (status, vote) = call(
        json!({"action": "propose", "state": "polling", "title": "Bike ride",
        "unresolvedFields": ["place"], "options": [
            {"label": "Sun 13:00", "startAt": later(0)}, {"label": "Sun 15:00", "startAt": later(2)}
        ]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{vote}");
    assert_eq!(vote["kind"], "vote");
    let event_id = vote["eventId"].as_str().unwrap().to_string();
    let (status, plan) = call(json!({"action": "propose", "existingEventId": event_id,
        "state": "awaitingConfirmation", "startAt": later(0), "options": []}))
    .await;
    assert_eq!(status, StatusCode::OK, "{plan}");
    assert_eq!(plan["eventId"], event_id.as_str());
    assert_eq!(plan["kind"], "plan");
    assert_eq!(plan["card"]["unresolvedFields"], json!(["place"]));
    let (task,): (String,) =
        query_as("SELECT created_by_task_run_id FROM cloud_plan_cards WHERE event_id = $1")
            .bind(&event_id)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(task, root);
}

#[tokio::test]
async fn a_resumed_exchange_on_the_cloud_runner_decides_with_a_card() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let resume = resumed_task(&f).await;
    let run = resume["runId"].as_str().unwrap().to_string();
    runner_lease(&f, &run, "runner-decides").await;
    let f = std::sync::Arc::new(f);
    let (shared, id) = (f.clone(), run.clone());
    decide_with_propose(
        move |arguments| {
            let (f, run) = (shared.clone(), id.clone());
            Box::pin(async move { runner_card(&f, &run, "runner-decides", arguments).await })
        },
        &f.root,
        &f.pool,
    )
    .await;
}

#[tokio::test]
async fn a_resumed_exchange_on_the_mac_decides_with_a_card() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let resume = resumed_task(&f).await;
    let run = resume["runId"].as_str().unwrap().to_string();
    let claim = f.claim(0, &resume).await;
    let (status, capabilities) = card_call(&f, 0, &run, claim, "capabilities", json!({})).await;
    assert_eq!(status, StatusCode::OK, "{capabilities}");
    let f = std::sync::Arc::new(f);
    let (shared, id) = (f.clone(), run.clone());
    decide_with_propose(
        move |arguments| {
            let (f, run) = (shared.clone(), id.clone());
            Box::pin(async move {
                let action = arguments["action"].as_str().unwrap_or_default().to_string();
                card_call(&f, 0, &run, claim, &action, arguments).await
            })
        },
        &f.root,
        &f.pool,
    )
    .await;
}
