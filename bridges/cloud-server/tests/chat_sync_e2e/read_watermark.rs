//! The read watermark: per author, the highest of their own messages another
//! member has read. Only a read that raises it tells the author.

use super::*;

#[tokio::test]
async fn a_second_reader_wakes_only_themselves() {
    let Some(pool) = try_pool().await else { return };
    let (group, people) = group_of(&pool, ["Ava", "Ben", "Cal", "Dee"]).await;
    let [ava, ben, cal, dee] = &people;
    let message = send(&pool, ava, group, "Synthetic lunch plan").await;
    let dee_head = sync_head(&pool, dee).await.0;

    read(&pool, ben, group, message).await;
    assert_eq!(
        cursor_events(&pool, ava, group).await,
        vec![author_event(ben, message, message)]
    );
    assert_eq!(watermark(&pool, ava, group).await, message);
    let ava_head = sync_head(&pool, ava).await.0;

    read(&pool, cal, group, message).await;

    assert_eq!(
        cursor_events(&pool, ava, group).await,
        vec![author_event(ben, message, message)],
        "Cal's read raised nothing, so Ava is not told"
    );
    assert_eq!(sync_head(&pool, ava).await.0, ava_head);
    assert_eq!(watermark(&pool, ava, group).await, message);
    assert_eq!(
        cursor_events(&pool, cal, group).await,
        vec![read_event(cal, message, message)]
    );
    assert!(cursor_events(&pool, dee, group).await.is_empty());
    assert_eq!(sync_head(&pool, dee).await.0, dee_head);
}

#[tokio::test]
async fn member_snapshots_carry_each_members_watermark() {
    let Some(pool) = try_pool().await else { return };
    let (group, people) = group_of(&pool, ["Ava", "Ben", "Cal"]).await;
    let [ava, ben, cal] = &people;
    let message = send(&pool, ava, group, "Synthetic snapshot check").await;
    send(&pool, ben, group, "Synthetic unread reply").await;
    read(&pool, cal, group, message).await;

    let bootstrap = store::bootstrap(&pool, ben).await.unwrap();
    let members = &bootstrap
        .conversations
        .iter()
        .find(|conversation| conversation.id == group)
        .unwrap()
        .members;
    let watermarks = |members: &[kordi_cloud_server::chat_sync::models::MemberSnapshot]| {
        [ava, ben, cal].map(|person| {
            members
                .iter()
                .find(|member| &member.account_id == person)
                .unwrap()
                .read_outbox_sequence
        })
    };
    assert_eq!(watermarks(members), [message, 0, 0]);
    let ava_member = members.iter().find(|member| &member.account_id == ava);
    eprintln!(
        "member snapshot: {}",
        serde_json::to_string(&ava_member).unwrap()
    );

    let dee = account(&pool, "Dee").await;
    connect_accounts(&pool, ava, &dee).await;
    let snapshot = store::add_conversation_members(
        &pool,
        ava,
        group,
        AddConversationMembersRequest {
            client_operation_id: Uuid::now_v7(),
            member_account_ids: vec![dee],
            replace: false,
        },
    )
    .await
    .expect("add Dee");
    assert_eq!(watermarks(&snapshot.members), [message, 0, 0]);
    let encoded = serde_json::to_value(&snapshot.members[0]).unwrap();
    assert!(encoded["read_outbox_sequence"].is_i64(), "{encoded}");
}

/// Four members keep writing and reading over each other's messages at the
/// same time. Each read raises the other authors' watermarks in account order
/// and locks no member row but its own, so none of them can deadlock.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_reads_over_each_others_messages_all_succeed() {
    let Some(pool) = try_pool().await else { return };
    let (group, people) = group_of(&pool, ["Ava", "Ben", "Cal", "Dee"]).await;
    for round in 0..40 {
        let sends = people.clone().map(|person| {
            let pool = pool.clone();
            tokio::spawn(async move { send(&pool, &person, group, "Synthetic busy group").await })
        });
        let mut head = 0;
        for task in sends {
            head = head.max(task.await.expect("send finished"));
        }
        let reads = people.clone().map(|person| {
            let pool = pool.clone();
            tokio::spawn(async move {
                store::advance_read_cursor(&pool, &person, group, cursor_request(head)).await
            })
        });
        for task in reads {
            task.await
                .expect("read finished")
                .unwrap_or_else(|error| panic!("round {round}: {error}"));
        }
    }

    // Everyone read everything, so each watermark is that author's newest.
    for person in &people {
        let newest = query_as::<_, (i64,)>(
            "SELECT MAX(conversation_sequence) FROM cloud_chat_messages \
             WHERE conversation_id = $1 AND sender_account_id = $2",
        )
        .bind(group)
        .bind(person)
        .fetch_one(&pool)
        .await
        .unwrap()
        .0;
        assert_eq!(watermark(&pool, person, group).await, newest, "{person}");
    }
}
