//! Account deletion against a task-owned disposable PostgreSQL database at
//! `$DATABASE_URL`; without it every test returns early. Every account,
//! name and email is synthetic and generated per test.

use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::*;
use crate::chat_sync::models::SendMessageRequest;
use crate::chat_sync::store;
use crate::deleted_account::DELETED_ACCOUNT_ID;

mod credentials;
mod direct;
mod operator;
mod quotes;

async fn pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    Some(crate::pg::init_pool(&url).await.expect("init test pool"))
}

/// A synthetic person: (account id, email).
async fn person(pool: &PgPool, name: &str) -> (String, String) {
    let suffix = Uuid::new_v4().simple().to_string();
    let account_id = format!("acct_deletion_{suffix}");
    let email = format!("deletion-{suffix}@example.test");
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, primary_email_verified_at, created_at, \
          updated_at, avatar_source, avatar_style, avatar_seed, avatar_renderer_version, \
          avatar_version, avatar_updated_at) \
         VALUES ($1, $2, $3, $4, $4, $4, 'generated', 'lorelei', $1, 'fixture', 1, $4)",
    )
    .bind(&account_id)
    .bind(name)
    .bind(&email)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    (account_id, email)
}

/// Makes two people contacts and opens their direct conversation.
async fn direct_conversation(pool: &PgPool, a: &str, b: &str) -> Uuid {
    let now = Utc::now().to_rfc3339();
    for (from, to) in [(a, b), (b, a)] {
        query(
            "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) \
             VALUES ($1, $2, $3)",
        )
        .bind(from)
        .bind(to)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();
    }
    let mut tx = pool.begin().await.unwrap();
    let conversation = crate::auth::routes::open_direct_conversation(&mut tx, a, b)
        .await
        .expect("open the direct conversation");
    tx.commit().await.unwrap();
    conversation.id
}

fn text(text: &str) -> Value {
    json!({"schema": 1, "blocks": [{"type": "text", "text": text}], "legacy_attachments": []})
}

async fn send(
    pool: &PgPool,
    sender: &str,
    conversation_id: Uuid,
    content: Value,
) -> Result<Uuid, store::StoreError> {
    store::send_message(
        pool,
        sender,
        conversation_id,
        SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            kind: "text".to_string(),
            content,
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .map(|outcome| outcome.value.id)
}

/// Deletes `account_id` in its own transaction, as the routes do.
async fn delete(pool: &PgPool, account_id: &str, policy: DirectConversations) -> Deletion {
    let mut tx = pool.begin().await.unwrap();
    let deletion = delete_in_transaction(&mut tx, account_id, policy)
        .await
        .expect("delete the account");
    tx.commit().await.unwrap();
    deletion
}

/// (sender, content) of every message, in order.
async fn messages(pool: &PgPool, conversation_id: Uuid) -> Vec<(Uuid, String, Value)> {
    query_as(
        "SELECT message_id, sender_account_id, content FROM cloud_chat_messages \
         WHERE conversation_id = $1 ORDER BY conversation_sequence",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// (account id, membership state) of every member, by account id.
async fn members(pool: &PgPool, conversation_id: Uuid) -> Vec<(String, String)> {
    query_as(
        "SELECT account_id, membership_state FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 ORDER BY account_id",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn account_exists(pool: &PgPool, account_id: &str) -> bool {
    query_as::<_, (bool,)>("SELECT EXISTS(SELECT 1 FROM cloud_accounts WHERE account_id = $1)")
        .bind(account_id)
        .fetch_one(pool)
        .await
        .unwrap()
        .0
}
