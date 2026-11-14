//! When the System agent acts, against a real database: plan talk waits for
//! silence, and loops and conflicts step in once, even across restarts.

use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::ownership_sweep_tests::{group, say, Chat};
use crate::plan_cards::models::{PlanCardProposeArgs, PlanCardState};
use crate::plan_cards::tests::participant;

impl Chat {
    /// Pretends the conversation has been quiet for longer than the silence
    /// window.
    pub(super) async fn let_silence_pass(&self) {
        query("UPDATE cloud_chat_messages SET created_at = now() - interval '15 minutes' WHERE conversation_id = $1")
            .bind(self.chat)
            .execute(&self.pool)
            .await
            .unwrap();
        query(
            "UPDATE cloud_pip_conversation_state SET hooks_fired = jsonb_set(hooks_fired,
                 '{planDiscussion,checkAfter}', to_jsonb(now() - interval '1 second'))
             WHERE conversation_id = $1 AND hooks_fired ? 'planDiscussion'
               AND jsonb_typeof(hooks_fired->'planDiscussion') = 'object'",
        )
        .bind(self.chat)
        .execute(&self.pool)
        .await
        .unwrap();
    }

    /// Gives Alice and Bob names, so their handles resolve.
    async fn name_people(&self) {
        for (account, name) in [(&self.alice, "Alice"), (&self.bob, "Bob")] {
            query("UPDATE cloud_accounts SET display_name = $2 WHERE account_id = $1")
                .bind(account)
                .bind(name)
                .execute(&self.pool)
                .await
                .unwrap();
        }
    }

    /// Finishes the System agent's active run as a runner would, and returns
    /// the text and mentions of the message it posted (null when silent).
    pub(super) async fn finish_run(&self, message: Option<&str>) -> Value {
        let (run_id,): (String,) = query_as(
            "SELECT active_run_id FROM cloud_pip_conversation_state WHERE conversation_id = $1",
        )
        .bind(self.chat)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        query("UPDATE cloud_agent_fallback_runs SET status = 'leased', claimed_by = 'test-runner' WHERE run_id = $1")
            .bind(&run_id)
            .execute(&self.pool)
            .await
            .unwrap();
        let output = json!({"message": message, "hooksHandled": []}).to_string();
        super::store::complete(&self.pool, &run_id, "test-runner", &output)
            .await
            .unwrap();
        let (response,): (Option<String>,) =
            query_as("SELECT response_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1")
                .bind(&run_id)
                .fetch_one(&self.pool)
                .await
                .unwrap();
        let Some(response) = response else {
            return Value::Null;
        };
        let (content,): (Value,) =
            query_as("SELECT content FROM cloud_chat_messages WHERE message_id::text = $1")
                .bind(&response)
                .fetch_one(&self.pool)
                .await
                .unwrap();
        super::input::cloud_envelope(content["blocks"][0]["text"].as_str().unwrap()).unwrap()
    }

    async fn agent_says(&self, owner: &str, text: &str) {
        let message = group(
            self.chat,
            json!({"id": Uuid::new_v4().to_string(), "senderAccountId": owner, "createdAtMs": 1,
                "senderKind": "agent", "deliveryState": "complete", "text": text}),
        );
        say(&self.pool, owner, self.chat, &message).await;
    }

    /// One finished collaboration request from `from`'s agent to `to`'s.
    async fn exchange(&self, from: &str, to: &str) {
        let run = format!("car_{}", Uuid::new_v4().simple());
        let requester = if from == self.alice {
            &self.bob
        } else {
            &self.alice
        };
        let now = chrono::Utc::now().to_rfc3339();
        query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at) VALUES($1,$1,$1,$2,$3,$4,'completed','task',$5,$5)")
            .bind(&run)
            .bind(&self.session)
            .bind(from)
            .bind(requester)
            .bind(&now)
            .execute(&self.pool)
            .await
            .unwrap();
        query("INSERT INTO cloud_agent_exchanges(exchange_id,parent_run_id,root_run_id,request_key,target_owner_id,target_agent_id,request_text,status) VALUES($1,$2,$2,'key',$3,$4,'Does Friday work?','completed')")
            .bind(Uuid::new_v4())
            .bind(&run)
            .bind(to)
            .bind(format!("cloud-agent:{to}"))
            .execute(&self.pool)
            .await
            .unwrap();
    }

    pub(super) async fn card(&self, by: &str, title: &str, hours_ahead: i64) {
        let start = chrono::Utc::now() + chrono::Duration::hours(hours_ahead);
        crate::plan_cards::store::propose(
            &self.pool,
            by,
            PlanCardProposeArgs {
                conversation_id: self.chat,
                existing_event_id: None,
                existing_revision: None,
                title: title.to_string(),
                start_at: Some(start.to_rfc3339()),
                end_at: None,
                location: None,
                state: PlanCardState::AwaitingConfirmation,
                unresolved_fields: Vec::new(),
                participants: vec![participant(&self.bob, "Bob", true)],
                source_message_ids: Vec::new(),
                options: Vec::new(),
            },
        )
        .await
        .expect("propose");
    }
}

fn trigger(input: &Value) -> (&str, &str) {
    (
        input["trigger"]["kind"].as_str().unwrap_or_default(),
        input["trigger"]["reason"].as_str().unwrap_or_default(),
    )
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn plan_talk_waits_for_silence_and_a_new_message_resets_it() {
    let chat = Chat::new().await;
    chat.name_people().await;
    say(&chat.pool, &chat.bob, chat.chat, "Dinner Friday at 7?").await;
    assert_eq!(chat.sweep().await, 0, "people are still talking");
    let discussion = chat.hooks().await["planDiscussion"].clone();
    assert!(discussion["fromSequence"].is_i64(), "{discussion}");
    assert_eq!(chat.sweep().await, 0, "not quiet yet");

    chat.let_silence_pass().await;
    say(&chat.pool, &chat.alice, chat.chat, "haha nice").await;
    assert_eq!(chat.sweep().await, 0, "a new message resets the silence");
    assert!(chat.hooks().await["planDiscussion"].is_object());

    chat.let_silence_pass().await;
    assert_eq!(chat.sweep().await, 1, "the discussion went quiet");
    let prompts = chat.system_agent_prompts().await;
    assert_eq!(trigger(&prompts[0]), ("silence", ""));
    let plan = prompts[0]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["text"] == "Dinner Friday at 7?")
        .unwrap();
    assert_eq!(plan["isNew"], true, "the discussion is the run's news");

    assert_eq!(
        prompts[0]["trigger"]["ask"]["mention"], "@Bob",
        "who started it"
    );
    // A message that names nobody is addressed to the person who can decide.
    let posted = chat
        .finish_run(Some("Is Friday at 7 still the plan?"))
        .await;
    assert_eq!(posted["text"], "@Bob Is Friday at 7 still the plan?");
    assert_eq!(posted["mentions"][0]["targetKind"], "person");
    assert_eq!(posted["mentions"][0]["humanId"], json!(chat.bob));
    assert!(chat.hooks().await["planDiscussion"].is_null());
    assert_eq!(chat.sweep().await, 0, "once");
    assert_eq!(chat.system_agent_prompts().await.len(), 1);
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn a_group_document_request_needs_no_facilitator_mention() {
    let chat = Chat::new().await;
    say(&chat.pool, &chat.bob, chat.chat, "The review went well.").await;
    assert_eq!(chat.sweep().await, 0);

    say(
        &chat.pool,
        &chat.alice,
        chat.chat,
        "\u{8bf7}\u{628a}\u{6211}\u{4eec}\u{521a}\u{8ba8}\u{8bba}\u{7684}\u{5185}\u{5bb9}\u{8d77}\u{8349}\u{6210}\u{4e00}\u{4efd}\u{6587}\u{6863}",
    )
    .await;
    assert_eq!(chat.sweep().await, 0);
    chat.let_silence_pass().await;
    assert_eq!(chat.sweep().await, 1);
    let prompts = chat.system_agent_prompts().await;
    assert_eq!(trigger(&prompts[0]).0, "silence");
    let (prompt,): (String,) = query_as(
        "SELECT system_prompt FROM cloud_agent_fallback_runs
         WHERE session_id = $1 AND run_id LIKE 'pip_%'",
    )
    .bind(&chat.session)
    .fetch_one(&chat.pool)
    .await
    .unwrap();
    assert!(prompt.contains("documentDraft"));
    assert!(prompt.contains("workflowCard"));
    assert_eq!(chat.sweep().await, 0, "only one run is queued");
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn a_discussion_an_agent_takes_never_reaches_the_system_agent() {
    let chat = Chat::new().await;
    chat.name_people().await;
    say(&chat.pool, &chat.bob, chat.chat, "Dinner Friday at 7?").await;
    assert_eq!(chat.sweep().await, 0);
    chat.ask_alices_agent().await;
    assert_eq!(chat.sweep().await, 0, "Alice's agent owns the dinner");
    chat.let_silence_pass().await;
    assert_eq!(
        chat.sweep().await,
        0,
        "its agent took it, so no silence run"
    );
    assert!(chat.hooks().await["planDiscussion"].is_null());
    assert!(chat.system_agent_prompts().await.is_empty());
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn agents_going_back_and_forth_get_one_step_in() {
    let chat = Chat::new().await;
    chat.name_people().await;
    let (alice, bob) = (chat.alice.clone(), chat.bob.clone());
    for round in 0..3 {
        let (from, to) = if round % 2 == 0 {
            (&alice, &bob)
        } else {
            (&bob, &alice)
        };
        chat.exchange(from, to).await;
    }
    chat.agent_says(&alice, "Still checking with Bob's agent.")
        .await;
    assert_eq!(
        chat.sweep().await,
        0,
        "three rounds are still a conversation"
    );
    chat.exchange(&bob, &alice).await;
    chat.agent_says(&bob, "Asking Alice's agent again.").await;
    assert_eq!(chat.sweep().await, 1, "four rounds without a card");
    let prompts = chat.system_agent_prompts().await;
    assert_eq!(trigger(&prompts[0]), ("loop", "repeated_rounds"));
    assert!(prompts[0]["hooks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|hook| hook["name"] != "new_messages"));

    // The agent that started the task is asked for the decision.
    assert_eq!(prompts[0]["trigger"]["ask"]["mention"], "@KordiAlice");
    let posted = chat.finish_run(Some("Please pick 7pm or 8pm.")).await;
    let mention = &posted["mentions"][0];
    assert_eq!(mention["targetKind"], "agent");
    assert_eq!(mention["agentId"], format!("cloud-agent:{alice}"));
    // A restart reads the same row: the loop never fires again.
    chat.agent_says(&alice, "Any update from Bob's agent?")
        .await;
    assert_eq!(chat.sweep().await, 0, "once");
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn overlapping_cards_get_one_step_in() {
    let chat = Chat::new().await;
    chat.name_people().await;
    chat.card(&chat.config.account_id.clone(), "Friday dinner", 30)
        .await;
    chat.card(&chat.alice.clone(), "Dinner on Friday", 30).await;
    // Distinct change times keep the newest card (the open one) stable.
    query(
        "UPDATE cloud_plan_cards SET updated_at = now() - CASE WHEN created_by_account_id = $2
             THEN interval '5 minutes' ELSE interval '4 minutes' END WHERE conversation_id = $1",
    )
    .bind(chat.chat)
    .bind(&chat.config.account_id)
    .execute(&chat.pool)
    .await
    .unwrap();
    // Both cards are new to the System agent, so it looks at them anyway; the
    // run is about the conflict.
    assert_eq!(chat.sweep().await, 1);
    let prompts = chat.system_agent_prompts().await;
    assert_eq!(trigger(&prompts[0]), ("conflict", "overlap"));
    let cards = prompts[0]["trigger"]["cards"].as_array().unwrap();
    assert_eq!(
        cards
            .iter()
            .filter(|card| card["createdBySystemAgent"] == true)
            .count(),
        1
    );

    // Whoever made the other card decides which plan to keep.
    assert_eq!(prompts[0]["trigger"]["ask"]["mention"], "@Alice");
    let posted = chat
        .finish_run(Some(
            "@KordiAlice these two dinner cards overlap; which one stays?",
        ))
        .await;
    assert_eq!(posted["mentions"].as_array().unwrap().len(), 1);
    assert_eq!(
        posted["mentions"][0]["targetKind"], "agent",
        "its own choice"
    );
    assert!(chat
        .hooks()
        .await
        .as_object()
        .unwrap()
        .keys()
        .any(|key| key.starts_with("conflict:")));
    query("UPDATE cloud_plan_cards SET updated_at = now() - interval '2 minutes' WHERE conversation_id = $1 AND created_by_account_id = $2")
        .bind(chat.chat)
        .bind(&chat.alice)
        .execute(&chat.pool)
        .await
        .unwrap();
    assert_eq!(chat.sweep().await, 0, "once");
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn a_stalled_agent_task_gets_one_addressed_step_in() {
    let chat = Chat::new().await;
    chat.name_people().await;
    chat.ask_alices_agent().await;
    say(&chat.pool, &chat.bob, chat.chat, "7pm, anything is fine").await;
    assert_eq!(chat.sweep().await, 0, "Alice's agent owns the dinner");
    chat.let_window_pass().await;
    assert_eq!(chat.sweep().await, 1, "the agent stalled");
    let prompts = chat.system_agent_prompts().await;
    assert_eq!(trigger(&prompts[0]), ("stall", "silent"));
    assert_eq!(prompts[0]["trigger"]["ask"]["mention"], "@Alice");
    let posted = chat.finish_run(Some("Does 7pm work for you?")).await;
    let text = posted["text"].as_str().unwrap();
    assert!(text.ends_with("\n@Alice Does 7pm work for you?"), "{text}");
    assert_eq!(posted["mentions"][0]["humanId"], json!(chat.alice));
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn a_step_in_that_publishes_a_card_needs_no_mention() {
    let chat = Chat::new().await;
    chat.name_people().await;
    say(&chat.pool, &chat.bob, chat.chat, "Dinner Friday at 7?").await;
    assert_eq!(chat.sweep().await, 0);
    chat.let_silence_pass().await;
    assert_eq!(chat.sweep().await, 1);
    // The run publishes the plan card with its tool.
    chat.card(&chat.config.account_id.clone(), "Friday dinner", 30)
        .await;
    let posted = chat.finish_run(Some("Card is up.")).await;
    assert_eq!(posted["text"], "Card is up.");
    assert!(posted["mentions"].as_array().unwrap().is_empty());
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn a_failed_agent_run_is_named_as_a_failure_and_keeps_its_owner() {
    let chat = Chat::new().await;
    chat.name_people().await;
    // An older client mentions the agent by label only.
    let request = group(
        chat.chat,
        json!({"id": Uuid::new_v4().to_string(), "senderAccountId": chat.bob, "createdAtMs": 1,
            "text": "@KordiAlice plan Friday dinner for us.",
            "mentions": [{"label": "KordiAlice", "targetKind": "agent"}]}),
    );
    let request_id = say(&chat.pool, &chat.bob, chat.chat, &request).await;
    let now = chrono::Utc::now().to_rfc3339();
    query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,error_code,created_at,updated_at) VALUES($1,$1,$2,$3,$4,$5,'failed','task','missing_provider_auth',$6,$6)")
        .bind(format!("car_{}", Uuid::new_v4().simple()))
        .bind(&request_id)
        .bind(&chat.session)
        .bind(&chat.alice)
        .bind(&chat.bob)
        .bind(&now)
        .execute(&chat.pool)
        .await
        .unwrap();
    assert_eq!(chat.sweep().await, 1, "a definite failure steps in at once");
    let prompts = chat.system_agent_prompts().await;
    assert_eq!(prompts[0]["stepIn"]["reason"], "failed");
    assert_eq!(prompts[0]["trigger"]["reason"], "failed");
    assert_eq!(
        prompts[0]["trigger"]["ask"]["participantId"],
        json!(chat.alice)
    );
    let stepped = &chat.hooks().await["steppedIn"];
    assert_eq!(stepped["owner"]["accountId"], json!(chat.alice));
    assert_eq!(stepped["cause"], "failed");
    let posted = chat.finish_run(Some("Which time works for you?")).await;
    assert_eq!(
        posted["text"],
        "KordiAlice couldn't answer, so I'm picking this up.\n@Alice Which time works for you?"
    );
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn a_conversation_that_cannot_be_read_never_stops_the_others() {
    let broken = Chat::new().await;
    // A second conversation of the same people and System agent.
    let (chat, session) = (Uuid::new_v4(), format!("session:group:{}", Uuid::new_v4()));
    let members = [&broken.bob, &broken.alice, &broken.config.account_id];
    crate::plan_cards::tests::seed_conversation(
        &broken.pool,
        chat,
        &broken.bob,
        &members.map(String::as_str),
    )
    .await;
    query("UPDATE cloud_chat_conversations SET legacy_session_id = $2 WHERE conversation_id = $1")
        .bind(chat)
        .bind(&session)
        .execute(&broken.pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_pip_conversation_state (conversation_id) VALUES ($1)")
        .bind(chat)
        .execute(&broken.pool)
        .await
        .unwrap();
    let healthy = Chat {
        pool: broken.pool.clone(),
        config: broken.config.clone(),
        chat,
        session,
        alice: broken.alice.clone(),
        bob: broken.bob.clone(),
    };
    for chat in [&broken, &healthy] {
        chat.name_people().await;
        say(&chat.pool, &chat.bob, chat.chat, "Dinner Friday at 7?").await;
        chat.let_silence_pass().await;
    }
    super::store::tests::break_conversation(broken.chat);
    // A malformed stored time is skipped by the sweep query itself.
    query("UPDATE cloud_pip_conversation_state SET hooks_fired = '{\"triggerCheckAfter\": \"soon\", \"cardsCheckedAt\": \"later\"}' WHERE conversation_id = $1")
        .bind(broken.chat)
        .execute(&broken.pool)
        .await
        .unwrap();
    // The broken conversation is looked at first, and fails.
    query("UPDATE cloud_pip_conversation_state SET checked_at = now() - interval '2 hours' WHERE conversation_id = $1")
        .bind(broken.chat)
        .execute(&broken.pool)
        .await
        .unwrap();
    let queued = super::store::sweep(&healthy.pool, &healthy.config)
        .await
        .expect("one broken conversation does not fail the sweep");
    assert_eq!(queued, 1);
    let prompts = healthy.system_agent_prompts().await;
    assert_eq!(trigger(&prompts[0]), ("silence", ""));
    let (retry_later, error): (bool, Option<String>) = query_as(
        "SELECT retry_after > now(), last_error FROM cloud_pip_conversation_state
         WHERE conversation_id = $1",
    )
    .bind(broken.chat)
    .fetch_one(&broken.pool)
    .await
    .unwrap();
    assert!(retry_later, "held back instead of retried every tick");
    assert_eq!(error.as_deref(), Some("sweep_failed"));
}
