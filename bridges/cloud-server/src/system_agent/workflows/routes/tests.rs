use super::*;
use crate::cloud_agent_runtime::runs::{complete_run, lease_canary_run, ClaimRunRequest};
use crate::events::EventBus;
use crate::system_agent::ownership_sweep_tests::{say, Chat};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

fn session(account_id: &str) -> Extension<CloudSession> {
    Extension(CloudSession {
        account_id: account_id.into(),
        device_id: "fixture".into(),
        token_id: "fixture".into(),
    })
}

async fn handoff_messages(chat: &Chat) -> Vec<(Uuid, Option<Uuid>, Value)> {
    query_as::<_, (Uuid, Option<Uuid>, String)>(
        "SELECT message_id, reply_to_message_id, content #>> '{blocks,0,text}'
         FROM cloud_chat_messages
         WHERE conversation_id=$1 AND starts_with(content #>> '{blocks,0,text}', 'kordi-cloud-group:')
         ORDER BY conversation_sequence",
    )
    .bind(chat.chat)
    .fetch_all(&chat.pool)
    .await
    .unwrap()
    .into_iter()
    .map(|(id, reply_to, body)| {
        let payload = URL_SAFE_NO_PAD
            .decode(body.strip_prefix("kordi-cloud-group:").unwrap())
            .unwrap();
        let envelope: Value = serde_json::from_slice(&payload).unwrap();
        (id, reply_to, envelope["message"].clone())
    })
    .collect()
}

async fn draft(chat: &Chat, text: &str, proposal: Value) -> Uuid {
    let source = say(&chat.pool, &chat.bob, chat.chat, text).await;
    assert_eq!(chat.sweep().await, 0);
    chat.let_silence_pass().await;
    assert_eq!(chat.sweep().await, 1);
    let (run_id,): (String,) =
        query_as("SELECT active_run_id FROM cloud_pip_conversation_state WHERE conversation_id=$1")
            .bind(chat.chat)
            .fetch_one(&chat.pool)
            .await
            .unwrap();
    query("UPDATE cloud_agent_fallback_runs SET status='running', claimed_by='fixture' WHERE run_id=$1")
        .bind(&run_id).execute(&chat.pool).await.unwrap();
    let mut proposal = proposal;
    proposal["sourceMessageIds"] = json!([source]);
    let response = json!({"message":null,"hooksHandled":[],"workflowCard":proposal}).to_string();
    crate::system_agent::store::complete(&chat.pool, &run_id, "fixture", &response)
        .await
        .unwrap();
    let (id,): (Uuid,) = query_as(
        "SELECT card_id FROM cloud_facilitator_cards WHERE run_id=$1 AND message_id IS NOT NULL",
    )
    .bind(&run_id)
    .fetch_one(&chat.pool)
    .await
    .unwrap();
    id
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn group_cards_require_the_right_member_actions() {
    let chat = Chat::new().await;
    query("UPDATE cloud_chat_conversation_members SET role='owner' WHERE conversation_id=$1 AND account_id=$2")
        .bind(chat.chat).bind(&chat.bob).execute(&chat.pool).await.unwrap();
    let state = Arc::new(ServerState::new(chat.pool.clone(), EventBus::noop()));
    let call = |account, id, action| {
        act(
            State(state.clone()),
            session(account),
            Path(id),
            Json(action),
        )
    };
    let poll = draft(
        &chat,
        "Should we ship CSV or spreadsheets first?",
        json!({
            "kind":"decision","title":"Choose an import format","options":["CSV","Spreadsheet"]
        }),
    )
    .await;
    let voted = call(
        &chat.alice,
        poll,
        Action::Vote {
            revision: 1,
            option: 0,
        },
    )
    .await
    .unwrap();
    assert_eq!(voted.0["myVote"], 0);
    let card = Card::load(&chat.pool, poll).await.unwrap().unwrap();
    assert_eq!(
        card.snapshot_for(&chat.pool, &chat.alice).await.unwrap()["myVote"],
        0
    );
    assert!(card.snapshot_for(&chat.pool, &chat.bob).await.unwrap()["myVote"].is_null());
    assert!(card
        .snapshot(&chat.pool)
        .await
        .unwrap()
        .get("myVote")
        .is_none());
    assert!(call(
        &chat.alice,
        poll,
        Action::Confirm {
            revision: 2,
            option: 0
        }
    )
    .await
    .is_err());
    let result = call(
        &chat.bob,
        poll,
        Action::Confirm {
            revision: 2,
            option: 0,
        },
    )
    .await
    .unwrap();
    assert_eq!(result.0["result"], "0");
    assert!(call(
        &chat.alice,
        poll,
        Action::Vote {
            revision: 2,
            option: 1
        }
    )
    .await
    .is_err());

    let memory = draft(&chat, "Remember this for the group: review sample imports.", json!({
        "kind":"memory","title":"Review imports","detail":"A second teammate reviews a sample import."
    })).await;
    let saved = call(&chat.bob, memory, Action::SaveMemory { revision: 1 })
        .await
        .unwrap();
    assert!(saved.0["result"].is_string());
    let saved_again = call(&chat.alice, memory, Action::SaveMemory { revision: 1 })
        .await
        .unwrap();
    assert_eq!(saved.0["result"], saved_again.0["result"]);

    let task = draft(&chat, "Assign the task to Alice: write the CSV checklist.", json!({
        "kind":"task","title":"Write the CSV checklist","detail":"Post five checks here.","assigneeId":chat.alice
    })).await;
    assert!(call(&chat.bob, task, Action::Approve).await.is_err());
    let (pending,): (String,) =
        query_as("SELECT status FROM cloud_agent_proactive_proposals WHERE proposal_id=$1")
            .bind(task_proposal_id(task))
            .fetch_one(&chat.pool)
            .await
            .unwrap();
    assert_eq!(pending, "pending");
    assert!(handoff_messages(&chat).await.is_empty());
    let approved = call(&chat.alice, task, Action::Approve).await.unwrap();
    assert_eq!(approved.0["result"], "approved");
    let run_id = proactive::decision::approved_run_id(&task_proposal_id(task));
    let (owner, prompt, request_id): (String, String, String) = query_as(
        "SELECT owner_account_id,prompt,request_message_id FROM cloud_agent_fallback_runs WHERE run_id=$1",
    )
    .bind(&run_id)
    .fetch_one(&chat.pool)
    .await
    .unwrap();
    assert_eq!(owner, chat.alice);
    assert!(prompt.contains("Post five checks here."));
    assert!(!prompt.contains("review sample imports"));
    assert_eq!(request_id, format!("facilitator-handoff:{task}"));
    assert!(call(&chat.alice, task, Action::Approve).await.is_err());

    let queued = handoff_messages(&chat).await;
    assert_eq!(queued.len(), 2);
    let (request_row, _, request) = &queued[0];
    let (reply_row, reply_to, reply) = &queued[1];
    assert_eq!(request["id"], request_id);
    assert_eq!(
        request["mentions"][0]["agentId"],
        format!("cloud-agent:{}", chat.alice)
    );
    let mention = request["mentions"][0]["displayText"].as_str().unwrap();
    assert!(request["text"].as_str().unwrap().starts_with(mention));
    assert_eq!(*reply_to, Some(*request_row));
    assert_eq!(reply["requestId"], request_id);
    assert_eq!(reply["deliveryState"], "queued");
    assert_eq!(reply["id"], run_id);

    let leased = lease_canary_run(&chat.pool, "fixture", &run_id)
        .await
        .unwrap()
        .unwrap();
    assert!(leased.history_messages.is_empty());
    assert!(!leased.agent_communication);
    assert!(leased.turn_identity["conversationMembersDigest"].is_null());
    let processing = handoff_messages(&chat).await;
    assert_eq!(processing.len(), 2);
    assert_eq!(processing[1].0, *reply_row);
    assert_eq!(processing[1].2["deliveryState"], "processing");

    let answer = "Check CSV headers, quoting, field counts, date formats, and duplicate IDs.";
    complete_run(&chat.pool, &run_id, "fixture", answer)
        .await
        .unwrap();
    let completed = handoff_messages(&chat).await;
    assert_eq!(completed.len(), 2);
    assert_eq!(completed[1].0, *reply_row);
    assert_eq!(completed[1].2["deliveryState"], "complete");
    assert_eq!(completed[1].2["text"], answer);
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn group_cards_let_the_assignees_ready_mac_claim_the_handoff() {
    let chat = Chat::new().await;
    let task = draft(&chat, "Assign the task to Alice: write the CSV checklist.", json!({
        "kind":"task","title":"Write the CSV checklist","detail":"Post five checks here.","assigneeId":chat.alice
    })).await;
    let Extension(device) = session(&chat.alice);
    let agent_id = proactive::agents::default_agent_id(&chat.alice);
    query("INSERT INTO cloud_devices (device_id, account_id, device_public_key, created_at, last_seen_at)
           VALUES ($1, $2, 'test-key', now()::text, now()::text)")
        .bind(&device.device_id).bind(&chat.alice).execute(&chat.pool).await.unwrap();
    query("INSERT INTO cloud_agent_desktop_capabilities (device_id, agent_id) VALUES ($1, $2), ($1, $3)")
        .bind(&device.device_id).bind(proactive::CAPABILITY).bind(&agent_id)
        .execute(&chat.pool).await.unwrap();
    query("INSERT INTO cloud_device_presence (device_id, account_id, state, last_heartbeat_at, updated_at)
           VALUES ($1, $2, 'online', now()::text, now()::text)")
        .bind(&device.device_id).bind(&chat.alice).execute(&chat.pool).await.unwrap();

    let proposal_id = task_proposal_id(task);
    proactive::decision::decide(
        &chat.pool,
        &chat.alice,
        &agent_id,
        &proposal_id,
        Choice::Allow,
    )
    .await
    .unwrap();
    let run_id = proactive::decision::approved_run_id(&proposal_id);
    assert!(lease_canary_run(&chat.pool, "fixture", &run_id)
        .await
        .unwrap()
        .is_none());
    let claim_id = Uuid::new_v4();
    let claim = proactive::desktop::claim_approved(
        &chat.pool,
        &device,
        claim_id,
        &ClaimRunRequest {
            request_message_id: run_id.clone(),
            session_id: chat.session.clone(),
            owner_account_id: chat.alice.clone(),
            requester_account_id: chat.alice.clone(),
            prompt: "proactive".into(),
            idempotency_key: run_id.clone(),
            runtime_route: None,
        },
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(claim["acquired"], true);
    let processing = handoff_messages(&chat).await;
    assert_eq!(processing.len(), 2);
    assert_eq!(processing[1].2["deliveryState"], "processing");
    let executor = proactive::desktop::executor(&device, claim_id);
    complete_run(&chat.pool, &run_id, &executor, "CSV checklist ready.")
        .await
        .unwrap();
    let completed = handoff_messages(&chat).await;
    assert_eq!(completed.len(), 2);
    assert_eq!(completed[1].0, processing[1].0);
    assert_eq!(completed[1].2["deliveryState"], "complete");
}
