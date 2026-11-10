//! Plan and vote cards a person's agent opens from its leased run (issue #2446).
use super::agent_exchanges::Fixture;
use super::*;
use sqlx_core::{query::query, query_as::query_as};

fn later(hours: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::days(3) + chrono::Duration::hours(hours)).to_rfc3339()
}

async fn card_call(
    f: &Fixture,
    person: usize,
    run: &str,
    claim: uuid::Uuid,
    action: &str,
    arguments: Value,
) -> (StatusCode, Value) {
    let response = f
        .router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{run}/plan-card"),
            &f.people[person].token,
            json!({"claimId": claim, "toolCallId": "call", "action": action, "arguments": arguments}),
        ))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

async fn root_call(f: &Fixture, action: &str, arguments: Value) -> (StatusCode, Value) {
    card_call(f, 0, &f.root, f.claim, action, arguments).await
}

/// The owner's card-only System notices carrying `event_id`, with each one's
/// view and revision.
async fn carriers(f: &Fixture, event_id: &str) -> Vec<(String, String, i64)> {
    let probe = json!([{"type": "plan_card", "eventId": event_id}]);
    let rows: Vec<(String, Value)> = query_as(
        "SELECT message_kind, content FROM cloud_chat_messages
         WHERE sender_account_id = $1 AND content->'blocks' @> $2::jsonb
         ORDER BY conversation_sequence",
    )
    .bind(&f.people[0].account_id)
    .bind(&probe)
    .fetch_all(&f.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|(kind, content)| {
            let block = &content["blocks"][0];
            (
                kind,
                block["view"].as_str().unwrap_or_default().to_string(),
                block["revision"].as_i64().unwrap_or_default(),
            )
        })
        .collect()
}

async fn member_action(f: &Fixture, person: usize, body: Value) -> Value {
    f.post(person, "/v1/cloud/plan_cards", body).await
}

#[tokio::test]
async fn a_person_agent_opens_one_plan_card_per_task_and_keeps_it_current() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let (status, capabilities) = root_call(&f, "capabilities", json!({})).await;
    assert_eq!(status, StatusCode::OK, "{capabilities}");
    assert_eq!(capabilities["available"], true);

    let (status, created) = root_call(
        &f,
        "create",
        json!({"action": "create", "kind": "plan", "title": "Coffee chat",
               "startAt": later(0), "endAt": later(1), "openItems": ["place"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["kind"], "plan");
    let event_id = created["eventId"].as_str().unwrap().to_string();
    assert_eq!(created["card"]["state"], "awaiting_confirmation");
    assert_eq!(created["card"]["counts"]["participants"], 3);
    assert_eq!(
        created["card"]["counts"]["going"], 1,
        "the owner organizes it"
    );

    let (agent, name, task): (String, String, String) = query_as(
        "SELECT created_by_agent_id, created_by_agent_name, created_by_task_run_id
         FROM cloud_plan_cards WHERE event_id = $1",
    )
    .bind(&event_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(agent, format!("cloud-agent:{}", f.people[0].account_id));
    assert!(
        !name.is_empty() && !name.contains("Exchange Alpha"),
        "{name}"
    );
    assert_eq!(task, f.root);
    // The card shows as the agent's message: its block names the agent.
    let (planner,): (Value,) = query_as(
        "SELECT content->'blocks'->0->'plannedBy' FROM cloud_chat_messages
         WHERE sender_account_id = $1 AND content->'blocks' @> $2::jsonb",
    )
    .bind(&f.people[0].account_id)
    .bind(json!([{"type": "plan_card", "eventId": event_id}]))
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(planner["agentId"], agent);
    assert_eq!(planner["agentName"], name);
    assert_eq!(planner["ownerAccountId"], f.people[0].account_id);
    assert_eq!(planner["ownerName"], "Exchange Alpha");
    assert_eq!(
        carriers(&f, &event_id).await,
        vec![("system-notice".to_string(), "event".to_string(), 1)]
    );

    // One card per task: a second create points back at the first.
    let (status, again) = root_call(
        &f,
        "create",
        json!({"title": "Coffee chat", "startAt": later(0)}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{again}");
    assert_eq!(again["errorCode"], "plan_card_exists");
    assert!(again["message"].as_str().unwrap().contains(&event_id));

    // An update fills the open place and keeps everything else.
    let (status, updated) = root_call(
        &f,
        "update",
        json!({"eventId": event_id, "location": "Corner cafe", "openItems": []}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["card"]["revision"], 2);
    assert_eq!(updated["card"]["location"], "Corner cafe");
    assert_eq!(updated["card"]["title"], "Coffee chat");
    assert_eq!(updated["card"]["unresolvedFields"], json!([]));
    assert_eq!(
        carriers(&f, &event_id).await,
        vec![("system-notice".to_string(), "event".to_string(), 2)],
        "the same message is refreshed in place"
    );

    // Members answer on the card as on any other; the owner's notice follows.
    let answered = member_action(
        &f,
        1,
        json!({"action": "rsvp", "eventId": event_id, "participantId": f.people[1].account_id, "rsvp": "yes"}),
    )
    .await;
    let confirmed = member_action(
        &f,
        0,
        json!({"action": "confirm", "eventId": event_id, "revision": answered["revision"], "confirmedBy": f.people[0].account_id}),
    )
    .await;
    assert_eq!(confirmed["state"], "confirmed");
    let latest = carriers(&f, &event_id).await;
    assert_eq!(latest.len(), 1);
    assert_eq!(latest[0].2, confirmed["revision"].as_i64().unwrap());

    // A confirmed plan stays as the members confirmed it.
    let (status, refused) = root_call(
        &f,
        "update",
        json!({"eventId": event_id, "location": "Elsewhere"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
}

#[tokio::test]
async fn a_person_agent_opens_a_vote_card_in_a_direct_chat_and_a_resolved_vote_shows_the_plan() {
    let Some(f) = Fixture::kind(false).await else {
        return;
    };
    let (status, created) = root_call(
        &f,
        "create",
        json!({"kind": "vote", "title": "Coffee chat", "openItems": ["place"], "options": [
            {"label": "Sat 10:00", "startAt": later(0), "endAt": later(1)},
            {"label": "Sat 14:00", "startAt": later(4), "endAt": later(5)}
        ]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["kind"], "vote");
    assert_eq!(created["card"]["counts"]["participants"], 2);
    let event_id = created["eventId"].as_str().unwrap().to_string();
    let option = created["card"]["options"][1]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        carriers(&f, &event_id).await,
        vec![("system-notice".to_string(), "vote".to_string(), 1)]
    );

    // A vote card needs real choices.
    let (status, _) = root_call(
        &f,
        "update",
        json!({"eventId": event_id, "kind": "vote", "options": [{"label": "Only one"}]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let voted = member_action(
        &f,
        1,
        json!({"action": "vote", "eventId": event_id, "participantId": f.people[1].account_id, "optionId": option}),
    )
    .await;
    member_action(
        &f,
        0,
        json!({"action": "confirm", "eventId": event_id, "revision": voted["revision"], "confirmedBy": f.people[0].account_id, "optionId": option}),
    )
    .await;
    let views: Vec<String> = carriers(&f, &event_id)
        .await
        .into_iter()
        .map(|(_, view, _)| view)
        .collect();
    assert_eq!(views, vec!["vote".to_string(), "event".to_string()]);
}

#[tokio::test]
async fn plan_cards_stay_with_the_run_its_conversation_and_its_agent() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    // Another member cannot use the owner's lease.
    let (status, _) = card_call(&f, 1, &f.root, f.claim, "capabilities", json!({})).await;
    assert_ne!(status, StatusCode::OK);

    // A card in another conversation, or one no agent opened, is not this
    // agent's to change.
    let (status, created) =
        root_call(&f, "create", json!({"title": "Lunch", "startAt": later(0)})).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let event_id = created["eventId"].as_str().unwrap().to_string();
    query("UPDATE cloud_plan_cards SET created_by_agent_id = NULL WHERE event_id = $1")
        .bind(&event_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let (status, _) = root_call(
        &f,
        "update",
        json!({"eventId": event_id, "title": "Brunch"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = root_call(
        &f,
        "update",
        json!({"eventId": "plan_missing", "title": "Brunch"}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // The agent answering this agent's request does not plan in parallel.
    f.send("ask-beta", 1).await;
    f.end_parent().await;
    let target = f.pending(1).await.remove(0);
    let claim = f.claim(1, &target).await;
    let (status, _) = card_call(
        &f,
        1,
        target["runId"].as_str().unwrap(),
        claim,
        "create",
        json!({"title": "Lunch", "startAt": later(0)}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_member_who_left_cannot_have_their_agent_plan_there() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    query("UPDATE cloud_chat_conversation_members SET membership_state = 'left' WHERE account_id = $1")
        .bind(&f.people[0].account_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let (status, _) = root_call(&f, "create", json!({"title": "Lunch", "startAt": later(0)})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
