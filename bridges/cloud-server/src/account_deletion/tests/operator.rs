//! The `delete-accounts` operator command: what it refuses, what a dry run
//! leaves alone, and a confirmed run.

use super::*;
use crate::account_deletion::operator::{dry_run, parse_entries, plan, run, Target};

fn entries(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn list_files_skip_blank_lines_and_comments() {
    let text = "# event cleanup\n\nacct_one\n  person@example.test  # met at the booth\n\
                odd#name@example.test\n   # indented comment\n";
    assert_eq!(
        parse_entries(text),
        entries(&["acct_one", "person@example.test", "odd#name@example.test"])
    );
}

#[tokio::test]
async fn the_command_refuses_overlap_unknown_entries_and_service_accounts() {
    let Some(pool) = pool().await else { return };
    let mut connection = pool.acquire().await.unwrap();
    crate::deleted_account::ensure_account(&mut connection)
        .await
        .unwrap();
    drop(connection);
    let (both, both_email) = person(&pool, "Harper Sample").await;
    let (only_deleted, only_deleted_email) = person(&pool, "Indy Sample").await;
    let unknown = format!("nobody-{}@example.test", Uuid::new_v4().simple());

    let refused = plan(
        &pool,
        &entries(&[
            &both_email.to_uppercase(),
            &only_deleted,
            &unknown,
            DELETED_ACCOUNT_ID,
        ]),
        &entries(&[&both]),
    )
    .await
    .unwrap()
    .expect_err("the command must refuse");
    let problems = refused.0.join("\n");
    assert_eq!(refused.0.len(), 3, "{problems}");
    assert!(
        problems.contains("are the same account") && problems.contains(&both),
        "{problems}"
    );
    assert!(problems.contains(&unknown) && problems.contains("matches no account"));
    assert!(
        problems.contains("an account the server runs"),
        "{problems}"
    );
    // Nothing was touched.
    assert!(account_exists(&pool, &both).await && account_exists(&pool, &only_deleted).await);

    let empty = plan(&pool, &[], &[])
        .await
        .unwrap()
        .expect_err("empty list");
    assert_eq!(empty.0, vec!["The delete list is empty.".to_string()]);
    let unknown_keep = plan(&pool, &entries(&[&only_deleted]), &entries(&[&unknown]))
        .await
        .unwrap()
        .expect_err("an unknown keep entry");
    assert!(unknown_keep.0[0].contains("Keep entry"), "{unknown_keep}");

    // An id and an email of one account are one target.
    let targets = plan(
        &pool,
        &entries(&[&only_deleted, &only_deleted_email]),
        &entries(&[&both_email]),
    )
    .await
    .unwrap()
    .expect("a valid plan");
    assert_eq!(
        targets,
        vec![Target {
            entry: only_deleted.clone(),
            account_id: only_deleted.clone(),
        }]
    );
}

#[tokio::test]
async fn a_dry_run_changes_nothing() {
    let Some(pool) = pool().await else { return };
    let (gone, gone_email) = person(&pool, "Jordan Sample").await;
    let (stays, _) = person(&pool, "Kai Sample").await;
    let conversation = direct_conversation(&pool, &gone, &stays).await;
    send(&pool, &gone, conversation, text("Hi")).await.unwrap();
    send(&pool, &stays, conversation, text("Hello"))
        .await
        .unwrap();
    let messages_before = messages(&pool, conversation).await;
    let members_before = members(&pool, conversation).await;
    let events_before = sync_events(&pool, &stays).await;

    let targets = plan(&pool, &entries(&[&gone_email]), &entries(&[&stays]))
        .await
        .unwrap()
        .expect("a valid plan");
    let outcomes = dry_run(&pool, &targets).await;

    assert_eq!(outcomes.len(), 1);
    let deletion = outcomes[0].result.as_ref().expect("the dry run succeeds");
    assert_eq!(deletion.conversations.direct_kept, 1);
    assert!(
        outcomes[0].line().contains("direct kept 1"),
        "{}",
        outcomes[0].line()
    );
    assert!(account_exists(&pool, &gone).await);
    assert_eq!(messages(&pool, conversation).await, messages_before);
    assert_eq!(members(&pool, conversation).await, members_before);
    let (closed,): (bool,) = query_as(
        "SELECT closed_at IS NOT NULL FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(conversation)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!closed);
    assert_eq!(sync_events(&pool, &stays).await, events_before);
}

async fn sync_events(pool: &PgPool, account_id: &str) -> i64 {
    query_as::<_, (i64,)>("SELECT COUNT(*) FROM cloud_chat_user_sync_events WHERE account_id = $1")
        .bind(account_id)
        .fetch_one(pool)
        .await
        .unwrap()
        .0
}

#[tokio::test]
async fn a_confirmed_run_deletes_each_account_and_goes_on_past_a_failure() {
    let Some(pool) = pool().await else { return };
    let (gone, _) = person(&pool, "Lane Sample").await;
    let (vanished, _) = person(&pool, "Morgan Sample").await;
    let (stays, _) = person(&pool, "Noel Sample").await;
    let conversation = direct_conversation(&pool, &gone, &stays).await;
    send(&pool, &gone, conversation, text("See you"))
        .await
        .unwrap();
    let targets = plan(&pool, &entries(&[&vanished, &gone]), &entries(&[&stays]))
        .await
        .unwrap()
        .expect("a valid plan");
    // The first account disappears after the plan was made.
    delete(&pool, &vanished, DirectConversations::Empty).await;
    let audits_before = operator_audits(&pool).await;

    let state = crate::server::ServerState::new(pool.clone(), crate::events::EventBus::noop());
    let outcomes = run(&state, &targets).await;

    assert_eq!(outcomes.len(), 2);
    assert!(outcomes[0].result.is_err(), "{}", outcomes[0].line());
    assert!(outcomes[1].result.is_ok(), "{}", outcomes[1].line());
    assert!(!account_exists(&pool, &gone).await);
    assert_eq!(messages(&pool, conversation).await.len(), 1);
    assert!(operator_audits(&pool).await > audits_before);
    let (metadata,): (String,) = query_as(
        "SELECT metadata_json FROM cloud_audit_events \
         WHERE event_type = 'account.deleted' AND metadata_json LIKE '%\"proof\":\"operator\"%' \
         ORDER BY created_at DESC LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!metadata.contains(&gone), "{metadata}");
}

async fn operator_audits(pool: &PgPool) -> i64 {
    query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM cloud_audit_events \
         WHERE event_type = 'account.deleted' AND metadata_json LIKE '%\"proof\":\"operator\"%'",
    )
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}
