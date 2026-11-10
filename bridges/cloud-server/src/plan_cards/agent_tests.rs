//! Cards a person's agent opened, against a real database (issue #2446).

use super::models::{PlanCardAgent, PlanCardProposeArgs, PlanCardRsvp, PlanCardState};
use super::routes::{dispatch_row, Actor};
use super::tests::{participant, seed_account, seed_conversation};
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

async fn pool() -> PgPool {
    let url =
        std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").expect("isolated test database required");
    let pool = sqlx_postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .expect("connect isolated database");
    crate::pg::pool::apply_migrations(&pool)
        .await
        .expect("migrate test database");
    pool
}

fn at(days: i64, hour: u32) -> String {
    let day = (chrono::Utc::now() + chrono::Duration::days(days)).date_naive();
    day.and_hms_opt(hour, 0, 0).unwrap().and_utc().to_rfc3339()
}

struct Chat {
    pool: PgPool,
    owner: String,
    member: String,
    conversation: Uuid,
    author: PlanCardAgent,
}

async fn chat() -> Chat {
    let pool = pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let owner = format!("ada-{suffix}");
    let member = format!("bo-{suffix}");
    for account in [&owner, &member] {
        seed_account(&pool, account).await;
    }
    let conversation = Uuid::new_v4();
    seed_conversation(&pool, conversation, &owner, &[&owner, &member]).await;
    query("UPDATE cloud_accounts SET display_name = 'Ada' WHERE account_id = $1")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    query("UPDATE cloud_chat_conversations SET group_title = 'Team' WHERE conversation_id = $1")
        .bind(conversation)
        .execute(&pool)
        .await
        .unwrap();
    let author = PlanCardAgent {
        agent_id: format!("cloud-agent:{owner}"),
        owner_account_id: owner.clone(),
        name: "Kordi".to_string(),
        owner_name: "Ada".to_string(),
        avatar_url: None,
    };
    Chat {
        pool,
        owner,
        member,
        conversation,
        author,
    }
}

impl Chat {
    async fn agent_card(&self, start: String) -> super::models::PlanCardRow {
        super::store::propose_for_agent(
            &self.pool,
            PlanCardProposeArgs {
                conversation_id: self.conversation,
                existing_event_id: None,
                existing_revision: None,
                title: "Coffee".to_string(),
                start_at: Some(start),
                end_at: None,
                location: None,
                state: PlanCardState::AwaitingConfirmation,
                unresolved_fields: vec!["place".to_string()],
                participants: vec![
                    participant(&self.owner, "Ada", true),
                    participant(&self.member, "Bo", false),
                ],
                source_message_ids: Vec::new(),
                options: Vec::new(),
            },
            &self.author,
            "run_task",
        )
        .await
        .expect("agent card")
    }

    /// The System agent's run proposing in this chat.
    async fn system_agent_proposes(&self, body: Value) -> Result<String, u16> {
        let actor = Actor {
            account_id: self.member.clone(),
            on_behalf_of_conversation: Some(self.conversation),
            represented_accounts: Default::default(),
            source_message_ids: Vec::new(),
        };
        let mut request = json!({
            "action": "propose",
            "conversationId": self.conversation.to_string(),
            "title": "Coffee",
            "state": "awaitingConfirmation",
            "participants": [{"participantId": self.owner, "displayName": "Ada"}],
        });
        request
            .as_object_mut()
            .unwrap()
            .extend(body.as_object().unwrap().clone());
        dispatch_row(&self.pool, &actor, serde_json::from_value(request).unwrap())
            .await
            .map(|row| row.event_id)
            .map_err(|response| response.status().as_u16())
    }
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn a_confirmed_agent_plan_names_the_agent_in_calendar_entries() {
    let chat = chat().await;
    let card = chat.agent_card(at(3, 17)).await;
    let stored = card.agent.clone().expect("the card records its agent");
    assert_eq!(
        (&stored.agent_id, &stored.owner_account_id, stored.label()),
        (
            &chat.author.agent_id,
            &chat.author.owner_account_id,
            chat.author.label()
        )
    );
    assert!(stored.avatar_url.is_some(), "the default agent's picture");
    super::store::rsvp(
        &chat.pool,
        &card.event_id,
        &chat.member,
        PlanCardRsvp::Yes,
        None,
    )
    .await
    .unwrap();
    let current = super::store::load(&chat.pool, &card.event_id)
        .await
        .unwrap()
        .unwrap();
    super::store::confirm(
        &chat.pool,
        &card.event_id,
        current.revision,
        &chat.owner,
        None,
        None,
    )
    .await
    .unwrap();
    super::projection::drain(&chat.pool, 100).await.unwrap();
    let (description,): (String,) = query_as(
        "SELECT payload->>'description' FROM cloud_calendar_events
         WHERE account_id = $1 AND event_id = $2",
    )
    .bind(&chat.member)
    .bind(format!("plan:{}", card.event_id))
    .fetch_one(&chat.pool)
    .await
    .unwrap();
    assert_eq!(description, "Planned with Ada's Kordi in Team.");
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn the_system_agent_keeps_answers_but_opens_no_second_card_for_an_agent_plan() {
    let chat = chat().await;
    let card = chat.agent_card(at(3, 17)).await;

    // An overlapping time, no time at all, or the agent's own card: refused.
    for body in [
        json!({"startAt": at(3, 18)}),
        json!({}),
        json!({"existingEventId": card.event_id, "existingRevision": card.revision, "startAt": at(3, 18)}),
    ] {
        assert_eq!(chat.system_agent_proposes(body).await, Err(409));
    }
    // A different time is a different plan.
    assert!(chat
        .system_agent_proposes(json!({"startAt": at(6, 9)}))
        .await
        .is_ok());

    // Its message sync posts the card in the owner's notice, never its own.
    let system_agent = format!("system-{}", Uuid::new_v4().simple());
    seed_account(&chat.pool, &system_agent).await;
    crate::system_agent::cards::sync_card_messages(&chat.pool, &system_agent, &card)
        .await
        .unwrap();
    let senders: Vec<(String, String)> = query_as(
        "SELECT sender_account_id, message_kind FROM cloud_chat_messages
         WHERE conversation_id = $1 AND content->'blocks' @> $2::jsonb",
    )
    .bind(chat.conversation)
    .bind(json!([{"type": "plan_card", "eventId": card.event_id}]))
    .fetch_all(&chat.pool)
    .await
    .unwrap();
    assert_eq!(
        senders,
        vec![(chat.owner.clone(), "system-notice".to_string())]
    );
}
