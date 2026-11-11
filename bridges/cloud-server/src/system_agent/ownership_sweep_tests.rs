//! One owner per task against a real database: the System agent leaves a
//! person's agent's task alone, then picks it up once that agent stalls.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::chat_sync::models::SendMessageRequest;
use crate::plan_cards::tests::{seed_account, seed_conversation};

pub(super) async fn say(pool: &PgPool, sender: &str, chat: Uuid, text: &str) -> String {
    let request = SendMessageRequest {
        client_message_id: Uuid::new_v4(),
        kind: "text".to_string(),
        content: json!({"schema": 1, "blocks": [{"type": "text", "text": text}], "legacy_attachments": []}),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    let sent = crate::chat_sync::store::send_message(pool, sender, chat, request)
        .await
        .expect("send message");
    query("UPDATE cloud_chat_messages SET created_at = now() - interval '5 minutes' WHERE conversation_id = $1")
        .bind(chat)
        .execute(pool)
        .await
        .unwrap();
    sent.value.id.to_string()
}

pub(super) fn group(chat: Uuid, message: Value) -> String {
    let envelope =
        json!({"kind": "group-message", "groupId": format!("group:{chat}"), "message": message});
    format!(
        "kordi-cloud-group:{}",
        URL_SAFE_NO_PAD.encode(envelope.to_string())
    )
}

pub(super) struct Chat {
    pub(super) pool: PgPool,
    pub(super) config: super::SystemAgentConfig,
    pub(super) chat: Uuid,
    pub(super) session: String,
    pub(super) alice: String,
    pub(super) bob: String,
}

impl Chat {
    pub(super) async fn new() -> Self {
        let url = std::env::var("KORDI_DIGEST_TEST_DATABASE_URL")
            .expect("isolated test database required");
        let pool = sqlx_postgres::PgPoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .expect("connect isolated database");
        crate::pg::pool::apply_migrations(&pool)
            .await
            .expect("migrate test database");
        let suffix = Uuid::new_v4().simple().to_string();
        let system_agent = format!("system-agent-{suffix}");
        let (alice, bob) = (format!("alice-{suffix}"), format!("bob-{suffix}"));
        for account in [&system_agent, &alice, &bob] {
            seed_account(&pool, account).await;
        }
        let chat = Uuid::new_v4();
        seed_conversation(&pool, chat, &bob, &[&bob, &alice, &system_agent]).await;
        let session = format!("session:group:{suffix}");
        query(
            "UPDATE cloud_chat_conversations SET legacy_session_id = $2 WHERE conversation_id = $1",
        )
        .bind(chat)
        .bind(&session)
        .execute(&pool)
        .await
        .unwrap();
        query("INSERT INTO cloud_pip_conversation_state (conversation_id) VALUES ($1)")
            .bind(chat)
            .execute(&pool)
            .await
            .unwrap();
        Self {
            config: super::test_config(&system_agent),
            pool,
            chat,
            session,
            alice,
            bob,
        }
    }

    pub(super) async fn sweep(&self) -> usize {
        query("UPDATE cloud_pip_conversation_state SET checked_at = now() - interval '1 hour'")
            .execute(&self.pool)
            .await
            .unwrap();
        super::store::sweep(&self.pool, &self.config)
            .await
            .expect("sweep")
    }

    pub(super) async fn hooks(&self) -> Value {
        let (hooks,): (Value,) = query_as(
            "SELECT hooks_fired FROM cloud_pip_conversation_state WHERE conversation_id = $1",
        )
        .bind(self.chat)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        hooks
    }

    /// Pretends the stall window has passed since the deferred task's last
    /// human message.
    pub(super) async fn let_window_pass(&self) {
        query(
            "UPDATE cloud_pip_conversation_state SET hooks_fired = jsonb_set(jsonb_set(hooks_fired,
                 '{deferred,lastHumanAt}', to_jsonb(now() - interval '20 minutes')),
                 '{deferred,checkAfter}', to_jsonb(now() - interval '1 minute'))
             WHERE conversation_id = $1",
        )
        .bind(self.chat)
        .execute(&self.pool)
        .await
        .unwrap();
    }

    pub(super) async fn run(&self, prefix: &str, request: &str, status: &str, lease_minutes: i64) {
        let now = chrono::Utc::now();
        let lease = (now + chrono::Duration::minutes(lease_minutes)).to_rfc3339();
        // Runs start with the message they answer, which `say` backdates.
        let now = now - chrono::Duration::minutes(5);
        query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,lease_expires_at,created_at,updated_at) VALUES($1,$1,$2,$3,$4,$5,$6,'task',$7,$8,$8)")
            .bind(format!("{prefix}{}", Uuid::new_v4().simple()))
            .bind(request)
            .bind(&self.session)
            .bind(&self.alice)
            .bind(&self.bob)
            .bind(status)
            .bind(lease)
            .bind(now.to_rfc3339())
            .execute(&self.pool)
            .await
            .unwrap();
    }

    pub(super) async fn ask_alices_agent(&self) {
        let alice = &self.alice;
        let request = group(
            self.chat,
            json!({"id": Uuid::new_v4().to_string(), "senderAccountId": self.bob, "createdAtMs": 1,
                "text": "@KordiAlice plan Friday dinner for us.",
                "targetCloudAgentId": format!("cloud-agent:{alice}"),
                "targetCloudAgentName": "KordiAlice", "targetCloudAgentOwnerAccountId": alice,
                "mentions": [{"label": "KordiAlice", "targetKind": "agent",
                    "targetIdentityId": format!("agent:cloud-agent:{alice}")}]}),
        );
        let request_id = say(&self.pool, &self.bob, self.chat, &request).await;
        self.run("car_", &request_id, "completed", 0).await;
        let question = group(
            self.chat,
            json!({"id": Uuid::new_v4().to_string(), "senderAccountId": alice, "createdAtMs": 2,
                "senderKind": "agent", "deliveryState": "complete", "replyToMessageId": request_id,
                "text": "Happy to. What time works for everyone?"}),
        );
        say(&self.pool, alice, self.chat, &question).await;
    }

    pub(super) async fn system_agent_prompts(&self) -> Vec<Value> {
        let rows: Vec<(String,)> = query_as(
            "SELECT prompt FROM cloud_agent_fallback_runs
             WHERE owner_account_id = $1 AND run_id LIKE 'pip\\_%' ORDER BY created_at",
        )
        .bind(&self.config.account_id)
        .fetch_all(&self.pool)
        .await
        .unwrap();
        rows.iter()
            .map(|(prompt,)| serde_json::from_str(prompt).unwrap())
            .collect()
    }
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn an_answer_to_an_agent_waits_for_that_agent_then_the_system_agent_steps_in() {
    let chat = Chat::new().await;
    chat.ask_alices_agent().await;
    say(&chat.pool, &chat.bob, chat.chat, "7pm, anything is fine").await;
    assert_eq!(chat.sweep().await, 0, "Alice's agent owns the dinner");
    let deferred = &chat.hooks().await["deferred"];
    assert_eq!(deferred["owner"]["accountId"], json!(chat.alice));
    assert_eq!(chat.sweep().await, 0, "not due for another look yet");

    chat.let_window_pass().await;
    assert_eq!(chat.sweep().await, 1, "the agent stalled");
    let hooks = chat.hooks().await;
    assert!(hooks.get("deferred").is_none());
    assert!(hooks["steppedIn"]["through"].as_i64().is_some());
    let prompts = chat.system_agent_prompts().await;
    let input = &prompts[0];
    assert!(input["stepIn"]["agentName"].as_str().is_some());
    let messages = input["messages"].as_array().unwrap();
    let answer = messages
        .iter()
        .find(|message| message["text"] == "7pm, anything is fine")
        .unwrap();
    assert_eq!(answer["isNew"], true);
    assert!(answer.get("agentOwned").is_none());
    assert!(messages.iter().any(|message| message["fromAgent"] == true));
    let line = super::ownership::with_step_in_line(input, "Card is up.");
    assert!(line.contains("hasn't replied, so I'm picking this up.\nCard is up."));
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn a_reply_from_the_owning_agent_ends_the_task_without_the_system_agent() {
    let chat = Chat::new().await;
    chat.ask_alices_agent().await;
    say(&chat.pool, &chat.bob, chat.chat, "7pm, anything is fine").await;
    assert_eq!(chat.sweep().await, 0);
    let reply = group(
        chat.chat,
        json!({"id": Uuid::new_v4().to_string(), "senderAccountId": chat.alice, "createdAtMs": 3,
            "senderKind": "agent", "deliveryState": "complete",
            "text": "Booked Friday 7pm at the usual place."}),
    );
    say(&chat.pool, &chat.alice, chat.chat, &reply).await;
    chat.let_window_pass().await;
    assert_eq!(chat.sweep().await, 0, "the agent answered its own task");
    assert!(chat.hooks().await.get("deferred").is_none());
    assert!(chat.system_agent_prompts().await.is_empty());
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn a_running_agent_is_never_overtaken_and_system_agent_runs_own_nothing() {
    let chat = Chat::new().await;
    say(&chat.pool, &chat.bob, chat.chat, "Dinner Friday at 7?").await;
    // The System agent's own runs and background work never own a task.
    chat.run("pip_", "pip-request", "running", 5).await;
    chat.run("digest_", "digest-request", "queued", 5).await;
    assert_eq!(chat.sweep().await, 0, "plain planning waits for silence");
    query("UPDATE cloud_chat_messages SET created_at = now() - interval '15 minutes' WHERE conversation_id = $1")
        .bind(chat.chat)
        .execute(&chat.pool)
        .await
        .unwrap();
    query("UPDATE cloud_pip_conversation_state SET hooks_fired = jsonb_set(hooks_fired, '{planDiscussion,checkAfter}', to_jsonb(now())) WHERE conversation_id = $1")
        .bind(chat.chat)
        .execute(&chat.pool)
        .await
        .unwrap();
    assert_eq!(chat.sweep().await, 1, "then the System agent sums it up");

    let chat = Chat::new().await;
    let request = say(&chat.pool, &chat.bob, chat.chat, "Dinner Friday at 7?").await;
    chat.run("car_", &request, "running", 5).await;
    assert_eq!(chat.sweep().await, 0, "Alice's agent is working on it");
    chat.let_window_pass().await;
    assert_eq!(chat.sweep().await, 0, "its lease is alive");
    query("UPDATE cloud_agent_fallback_runs SET status = 'failed', updated_at = now()::text WHERE session_id = $1")
        .bind(&chat.session)
        .execute(&chat.pool)
        .await
        .unwrap();
    query("UPDATE cloud_pip_conversation_state SET hooks_fired = jsonb_set(hooks_fired, '{deferred,checkAfter}', to_jsonb(now() - interval '1 minute')) WHERE conversation_id = $1")
        .bind(chat.chat)
        .execute(&chat.pool)
        .await
        .unwrap();
    assert_eq!(chat.sweep().await, 1, "the run failed without a reply");
}
