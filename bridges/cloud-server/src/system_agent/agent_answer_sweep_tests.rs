//! A person answering an agent, and an agent finishing in place, against a
//! real database: neither is new plan talk for the System agent.

use serde_json::json;
use sqlx_core::query::query;
use uuid::Uuid;

use super::ownership_sweep_tests::{group, say, Chat};

impl Chat {
    /// A finished run of Alice's agent in this conversation, `minutes_ago`.
    async fn alices_finished_run(&self, minutes_ago: i64) -> String {
        let run = format!("car_{}", Uuid::new_v4().simple());
        let at = (chrono::Utc::now() - chrono::Duration::minutes(minutes_ago)).to_rfc3339();
        query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at) VALUES($1,$1,$1,$2,$3,$4,'completed','task',$5,$5)")
            .bind(&run)
            .bind(&self.session)
            .bind(&self.alice)
            .bind(&self.bob)
            .bind(&at)
            .execute(&self.pool)
            .await
            .unwrap();
        run
    }
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn an_answer_to_an_agent_and_its_in_place_reply_never_reach_the_system_agent() {
    let chat = Chat::new().await;
    // Alice's agent shows its working row, then asks Bob through an exchange.
    let slot = group(
        chat.chat,
        json!({"id": Uuid::new_v4().to_string(), "senderAccountId": chat.alice, "createdAtMs": 1,
            "senderKind": "agent", "deliveryState": "complete",
            "text": "Working on the dinner plan with Bob."}),
    );
    let slot_id = say(&chat.pool, &chat.alice, chat.chat, &slot).await;
    let answer = say(&chat.pool, &chat.bob, chat.chat, "8pm works for me").await;
    let run = chat.alices_finished_run(10).await;
    query("INSERT INTO cloud_agent_exchanges(exchange_id,parent_run_id,root_run_id,request_key,target_owner_id,target_agent_id,request_text,status,response_message_id) VALUES($1,$2,$2,'key',$3,$4,'What time works?','completed',$5::uuid)")
        .bind(Uuid::new_v4())
        .bind(&run)
        .bind(&chat.bob)
        .bind(format!("cloud-agent:{}", chat.bob))
        .bind(&answer)
        .execute(&chat.pool)
        .await
        .unwrap();
    assert_eq!(chat.sweep().await, 0, "the answer is Alice's agent's task");
    let hooks = chat.hooks().await;
    assert_eq!(hooks["deferred"]["owner"]["accountId"], json!(chat.alice));
    assert!(hooks["planDiscussion"].is_null(), "never plan talk");

    // The agent finishes by completing its earlier row in place.
    query("UPDATE cloud_chat_messages SET version = version + 1, edited_at = now() WHERE message_id = $1::uuid")
        .bind(&slot_id)
        .execute(&chat.pool)
        .await
        .unwrap();
    chat.let_window_pass().await;
    assert_eq!(chat.sweep().await, 0, "the updated row is its reply");
    let hooks = chat.hooks().await;
    assert!(hooks.get("deferred").is_none(), "{hooks}");
    assert!(hooks.get("steppedIn").is_none());
    assert!(chat.system_agent_prompts().await.is_empty());
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn an_agent_finishing_its_task_closes_the_plan_talk_it_covered() {
    let chat = Chat::new().await;
    say(&chat.pool, &chat.bob, chat.chat, "Dinner Friday at 7?").await;
    assert_eq!(chat.sweep().await, 0);
    assert!(chat.hooks().await["planDiscussion"].is_object());
    // Alice's agent took up and finished a task after the plan talk began.
    let run = chat.alices_finished_run(1).await;
    query("UPDATE cloud_pip_conversation_state SET hooks_fired = jsonb_set(hooks_fired, '{planDiscussion,checkAfter}', to_jsonb(now() - interval '1 second')) WHERE conversation_id = $1")
        .bind(chat.chat)
        .execute(&chat.pool)
        .await
        .unwrap();
    assert_eq!(chat.sweep().await, 0, "the agent covered it");
    assert!(chat.hooks().await["planDiscussion"].is_null());

    // Genuinely new plan talk afterwards is the System agent's again.
    query("UPDATE cloud_agent_fallback_runs SET created_at = (now() - interval '1 hour')::text, updated_at = (now() - interval '1 hour')::text WHERE run_id = $1")
        .bind(&run)
        .execute(&chat.pool)
        .await
        .unwrap();
    say(
        &chat.pool,
        &chat.bob,
        chat.chat,
        "New idea: lunch Saturday at noon?",
    )
    .await;
    assert_eq!(chat.sweep().await, 0, "held until quiet");
    query("UPDATE cloud_chat_messages SET created_at = now() - interval '15 minutes' WHERE conversation_id = $1")
        .bind(chat.chat)
        .execute(&chat.pool)
        .await
        .unwrap();
    query("UPDATE cloud_pip_conversation_state SET hooks_fired = jsonb_set(hooks_fired, '{planDiscussion,checkAfter}', to_jsonb(now() - interval '1 second')) WHERE conversation_id = $1")
        .bind(chat.chat)
        .execute(&chat.pool)
        .await
        .unwrap();
    assert_eq!(chat.sweep().await, 1);
    let prompts = chat.system_agent_prompts().await;
    assert_eq!(prompts[0]["trigger"]["kind"], "silence");
}
