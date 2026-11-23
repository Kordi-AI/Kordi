//! Signing in again with the Google account of a deleted account gives a
//! new, empty account (docs/development/account-deletion.md). Runs against a
//! task-owned disposable Postgres at `$DATABASE_URL` with synthetic data.

use super::*;
use crate::account_deletion::reregistration_fixture::{assert_fresh, give_history};

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn google_sign_in_after_deletion_creates_a_new_empty_account() {
    let pool = crate::pg::init_pool(
        &std::env::var("DATABASE_URL").expect("a disposable database is required"),
    )
    .await
    .unwrap();
    let email = format!(
        "google-again-{}@example.test",
        uuid::Uuid::new_v4().simple()
    );
    let profile = OAuthProfile {
        provider_subject: format!("google-subject-{}", uuid::Uuid::new_v4().simple()),
        username: None,
        display_name: Some("Synthetic tester".to_string()),
        email: Some(email.clone()),
        email_verified: true,
        avatar_url: None,
        hosted_domain: None,
    };
    let (first, _) = complete_oauth_login(
        &pool,
        OAuthProvider::Google,
        profile.clone(),
        &legacy_device_registration("synthetic"),
    )
    .await
    .unwrap();
    let old_id = first.account.account_id.clone();
    let peer = give_history(&pool, &old_id).await;

    // The deletion both the route and the operator command run.
    let mut tx = pool.begin().await.unwrap();
    crate::account_deletion::delete_and_record(
        &mut tx,
        &old_id,
        crate::account_deletion::DirectConversations::Empty,
        "recent_sign_in",
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();

    // The same Google subject and email: a new account, never `email_in_use`.
    let (again, _) = complete_oauth_login(
        &pool,
        OAuthProvider::Google,
        profile,
        &legacy_device_registration("synthetic"),
    )
    .await
    .expect("a new account, not a refusal");
    assert_fresh(&pool, &again.account.account_id, &old_id, &peer).await;
    let (identities,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_account_identities WHERE provider = 'google' AND email = $1",
    )
    .bind(&email)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(identities, 1, "one identity, on the new account");
}
