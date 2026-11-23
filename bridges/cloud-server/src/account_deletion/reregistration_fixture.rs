//! Test support for signing up again after a deletion: give an account some
//! history, then check that a new account with the same email or provider
//! sign-in starts empty. Every name and email is synthetic.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

/// Gives `account_id` a contact, a direct conversation with a message, a
/// memory, and a membership in the contact's team organization. Returns the
/// contact's account id.
pub(crate) async fn give_history(pool: &PgPool, account_id: &str) -> String {
    let suffix = Uuid::new_v4().simple().to_string();
    let peer = format!("acct_history_{suffix}");
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, avatar_source, \
          avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, 'History contact', $2, $3, $3, 'generated', 'lorelei', $1, 'fixture', 1, $3)",
    )
    .bind(&peer)
    .bind(format!("history-{suffix}@example.test"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    for (from, to) in [(account_id, peer.as_str()), (peer.as_str(), account_id)] {
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
    let conversation = crate::auth::routes::open_direct_conversation(&mut tx, account_id, &peer)
        .await
        .expect("open the direct conversation");
    tx.commit().await.unwrap();
    crate::chat_sync::store::send_message(
        pool,
        account_id,
        conversation.id,
        crate::chat_sync::models::SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            kind: "text".to_string(),
            content: serde_json::json!({"schema": 1,
                "blocks": [{"type": "text", "text": "Before the deletion"}],
                "legacy_attachments": []}),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("send a message");
    query(
        "INSERT INTO cloud_account_memories \
         (memory_id, owner_account_id, scope, scope_id, source, text, categories) \
         VALUES ($1, $2, 'global', 'account', 'manual', 'Prefers mornings', \
                 ARRAY['general_preferences'])",
    )
    .bind(format!("mem_history_{suffix}"))
    .bind(account_id)
    .execute(pool)
    .await
    .unwrap();
    let organization = format!("org_history_{suffix}");
    query(
        "INSERT INTO cloud_organizations (organization_id, name, kind, created_by_account_id) \
         VALUES ($1, 'History team', 'team', $2)",
    )
    .bind(&organization)
    .bind(&peer)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_organization_members (organization_id, account_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(&organization)
    .bind(account_id)
    .execute(pool)
    .await
    .unwrap();
    peer
}

async fn count(pool: &PgPool, sql: &str, account_id: &str) -> i64 {
    query_as::<_, (i64,)>(sql)
        .bind(account_id)
        .fetch_one(pool)
        .await
        .unwrap()
        .0
}

/// `new_id` is a new account that holds nothing `old_id` had: no contacts,
/// conversations, memories or organizations, and only the device it just
/// signed in on.
pub(crate) async fn assert_fresh(pool: &PgPool, new_id: &str, old_id: &str, peer: &str) {
    assert_ne!(new_id, old_id, "a new account id");
    assert_eq!(
        count(
            pool,
            "SELECT COUNT(*) FROM cloud_accounts WHERE account_id = $1",
            old_id
        )
        .await,
        0
    );
    for (what, sql) in [
        (
            "contacts",
            "SELECT COUNT(*) FROM cloud_contacts WHERE account_id = $1 OR peer_account_id = $1",
        ),
        (
            "conversations",
            "SELECT COUNT(*) FROM cloud_chat_conversation_members WHERE account_id = $1",
        ),
        (
            "memories",
            "SELECT COUNT(*) FROM cloud_account_memories WHERE owner_account_id = $1",
        ),
        (
            "organizations other than its own",
            "SELECT COUNT(*) FROM cloud_organization_members member \
             JOIN cloud_organizations organization USING (organization_id) \
             WHERE member.account_id = $1 \
               AND organization.personal_account_id IS DISTINCT FROM $1",
        ),
    ] {
        assert_eq!(count(pool, sql, new_id).await, 0, "{what}");
    }
    assert_eq!(
        count(
            pool,
            "SELECT COUNT(*) FROM cloud_devices WHERE account_id = $1",
            new_id
        )
        .await,
        1,
        "only the device it just signed in on"
    );
    // The contact no longer sees anyone in its contact list.
    assert_eq!(
        count(
            pool,
            "SELECT COUNT(*) FROM cloud_contacts WHERE account_id = $1",
            peer
        )
        .await,
        0
    );
}
