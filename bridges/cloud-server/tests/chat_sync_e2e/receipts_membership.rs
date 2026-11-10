//! Receipts and membership changes: late joiners, members who left, and
//! server-managed members.

use super::receipts::{
    cursor_events, deliver, delivered_event, group_of, read, read_event, send, CursorEvent,
};
use super::*;
use kordi_cloud_server::system_account::{self, SYSTEM_ACCOUNT_ID};
use std::collections::BTreeMap;

/// What a client keeps per member: account id to (delivered, read).
type CursorCopy = BTreeMap<String, (i64, i64)>;

/// Applies cursor events the way the apps do: each one moves that member's
/// cursors forward in the local copy of the conversation.
fn apply(copy: &mut CursorCopy, events: &[CursorEvent]) {
    for (_, member, delivered, read) in events {
        if let Some(cursors) = copy.get_mut(member) {
            *cursors = (cursors.0.max(*delivered), cursors.1.max(*read));
        }
    }
}

/// Who, besides the author, has delivered and read the message at `sequence`.
fn receipt_state(copy: &CursorCopy, author: &str, sequence: i64) -> (Vec<String>, Vec<String>) {
    let others = || {
        copy.iter()
            .filter(move |(member, _)| member.as_str() != author)
    };
    (
        others()
            .filter(|(_, cursors)| cursors.0 >= sequence)
            .map(|(member, _)| member.clone())
            .collect(),
        others()
            .filter(|(_, cursors)| cursors.1 >= sequence)
            .map(|(member, _)| member.clone())
            .collect(),
    )
}

#[tokio::test]
async fn a_late_member_sees_current_cursors_and_receipts_for_their_messages() {
    let Some(pool) = try_pool().await else { return };
    let (group, people) = group_of(&pool, ["Ava", "Ben", "Cal"]).await;
    let [ava, ben, cal] = &people;
    let early = send(&pool, ava, group, "Synthetic early plan").await;
    read(&pool, ben, group, early).await;
    deliver(&pool, cal, group, early).await;

    let fay = account(&pool, "Fay").await;
    connect_accounts(&pool, ava, &fay).await;
    store::add_conversation_members(
        &pool,
        ava,
        group,
        AddConversationMembersRequest {
            client_operation_id: Uuid::now_v7(),
            member_account_ids: vec![fay.clone()],
            replace: false,
        },
    )
    .await
    .expect("add Fay");
    // Fay never saw the earlier moves, yet both of her copies carry them.
    assert!(cursor_events(&pool, &fay, group).await.is_empty());
    let joined: serde_json::Value = query_as::<_, (serde_json::Value,)>(
        "SELECT payload FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND conversation_id = $2 AND event_type = 'membership.updated' \
         ORDER BY stream_seq DESC LIMIT 1",
    )
    .bind(&fay)
    .bind(group)
    .fetch_one(&pool)
    .await
    .unwrap()
    .0;
    let synced: CursorCopy = joined["conversation"]["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|member| {
            (
                member["account_id"].as_str().unwrap().to_string(),
                (
                    member["last_delivered_sequence"].as_i64().unwrap(),
                    member["last_read_sequence"].as_i64().unwrap(),
                ),
            )
        })
        .collect();
    let bootstrap = store::bootstrap(&pool, &fay).await.unwrap();
    let mut copy: CursorCopy = bootstrap
        .conversations
        .iter()
        .find(|conversation| conversation.id == group)
        .unwrap()
        .members
        .iter()
        .map(|member| {
            (
                member.account_id.clone(),
                (member.last_delivered_sequence, member.last_read_sequence),
            )
        })
        .collect();
    assert_eq!(copy, synced);
    assert_eq!(copy[ben], (early, early));
    assert_eq!(copy[cal], (early, 0));

    let mine = send(&pool, &fay, group, "Synthetic question from Fay").await;
    read(&pool, ben, group, mine).await;
    apply(&mut copy, &cursor_events(&pool, &fay, group).await);
    assert_eq!(
        receipt_state(&copy, &fay, mine),
        (vec![ben.clone()], vec![ben.clone()])
    );

    deliver(&pool, cal, group, mine).await;
    apply(&mut copy, &cursor_events(&pool, &fay, group).await);
    let mut delivered = vec![ben.clone(), cal.clone()];
    delivered.sort();
    assert_eq!(
        receipt_state(&copy, &fay, mine),
        (delivered, vec![ben.clone()])
    );
}

#[tokio::test]
async fn an_author_who_left_is_not_told() {
    let Some(pool) = try_pool().await else { return };
    let (group, people) = group_of(&pool, ["Ava", "Ben", "Cal", "Dee", "Eli"]).await;
    let [ava, ben, cal, dee, eli] = &people;
    let space = query_as::<_, (String,)>(
        "SELECT legacy_session_id FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(group)
    .fetch_one(&pool)
    .await
    .unwrap()
    .0;
    send(&pool, ben, group, "Synthetic parting note").await;
    store::leave_group(&pool, ben, &space)
        .await
        .expect("Ben leaves");
    let ben_head = sync_head(&pool, ben).await.0;
    let latest = send(&pool, dee, group, "Synthetic reply after Ben left").await;

    read(&pool, cal, group, latest).await;

    assert!(cursor_events(&pool, ben, group).await.is_empty());
    assert_eq!(sync_head(&pool, ben).await.0, ben_head);
    let expected = vec![read_event(cal, latest, latest)];
    for person in [ava, cal, dee] {
        assert_eq!(
            cursor_events(&pool, person, group).await,
            expected,
            "{person}"
        );
    }
    assert!(cursor_events(&pool, eli, group).await.is_empty());
}

#[tokio::test]
async fn server_managed_authors_are_not_told() {
    let Some(pool) = try_pool().await else { return };
    let (group, people) = group_of(&pool, ["Ava", "Ben", "Cal"]).await;
    let [ava, ben, cal] = &people;
    system_account::join(&pool, group)
        .await
        .expect("System joins");
    let notice = send(&pool, SYSTEM_ACCOUNT_ID, group, "Synthetic System notice").await;

    deliver(&pool, ben, group, notice).await;

    assert!(cursor_events(&pool, SYSTEM_ACCOUNT_ID, group)
        .await
        .is_empty());
    // Ava wrote the "created the group" line, which this delivery also passed.
    let expected = vec![delivered_event(ben, notice, 0)];
    assert_eq!(cursor_events(&pool, ava, group).await, expected);
    assert_eq!(cursor_events(&pool, ben, group).await, expected);
    assert!(cursor_events(&pool, cal, group).await.is_empty());
}
