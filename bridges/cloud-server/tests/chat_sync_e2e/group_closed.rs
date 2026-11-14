//! Closing a group or a channel keeps its members and history readable and
//! refuses every new write (docs/development/group-closed-state.md).

use super::group_lifecycle::{active_people, group_request, removal_events};
use super::*;

fn text(body: &str) -> SendMessageRequest {
    SendMessageRequest {
        client_message_id: Uuid::now_v7(),
        kind: "text".into(),
        content: content(body),
        reply_to_message_id: None,
        attachment_ids: vec![],
    }
}

fn closed_code<T>(result: Result<T, StoreError>) -> &'static str {
    match result {
        Err(StoreError::Conflict { code, .. }) => code,
        Err(other) => panic!("expected group_closed, got {other:?}"),
        Ok(_) => panic!("expected group_closed, the write succeeded"),
    }
}

/// The `closed` objects of the `conversation.updated` events `account_id`
/// received for `conversation_id`, in order.
async fn close_events(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
) -> Vec<serde_json::Value> {
    query_as::<_, (serde_json::Value,)>(
        "SELECT payload FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND conversation_id = $2 AND event_type = 'conversation.updated' \
         ORDER BY stream_seq",
    )
    .bind(account_id)
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|(payload,)| payload["conversation"]["closed"].clone())
    .filter(|closed| !closed.is_null())
    .collect()
}

#[tokio::test]
async fn only_an_admin_closes_a_group_and_everyone_keeps_reading_it() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "close-owner").await;
    let admin = account(&pool, "close-admin").await;
    let member = account(&pool, "close-member").await;
    let outsider = account(&pool, "close-outsider").await;
    connect_accounts(&pool, &owner, &admin).await;
    connect_accounts(&pool, &owner, &member).await;
    let group = store::create_conversation(
        &pool,
        &owner,
        group_request(vec![admin.clone(), member.clone()], None),
    )
    .await
    .unwrap()
    .value;
    let space = group.legacy_session_id.clone().unwrap();
    query("UPDATE cloud_chat_conversation_members SET role = 'admin' WHERE conversation_id = $1 AND account_id = $2")
        .bind(group.id).bind(&admin).execute(&pool).await.unwrap();
    let channel = store::create_group_channel(
        &pool,
        &owner,
        &space,
        group_request(vec![], Some("Synthetic launch channel")),
    )
    .await
    .unwrap()
    .value;
    let hello = store::send_message(&pool, &member, group.id, text("hello"))
        .await
        .unwrap()
        .value;
    let now = chrono::Utc::now();
    query(
        "INSERT INTO cloud_group_invitations (invitation_id, inviter_account_id, token_hash, group_id, \
           group_space_id, group_title, group_snapshot, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $4, 'Synthetic group', '{}'::jsonb, $5, $6)",
    )
    .bind(format!("groupinv_{}", Uuid::new_v4().simple()))
    .bind(&owner)
    .bind(Uuid::new_v4().to_string())
    .bind(&space)
    .bind(now.to_rfc3339())
    .bind((now + chrono::Duration::days(7)).to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();

    for denied in [&member, &outsider] {
        assert!(matches!(
            store::dissolve_group(&pool, denied, &space).await,
            Err(StoreError::Forbidden)
        ));
    }
    assert!(!store::group_space_closed(&pool, &space).await.unwrap());

    let outcome = store::dissolve_group(&pool, &admin, &space).await.unwrap();
    let mut closed = outcome.conversation_ids.clone();
    closed.sort();
    let mut expected = vec![group.id, channel.id];
    expected.sort();
    assert_eq!(closed, expected);
    let mut people = vec![owner.clone(), admin.clone(), member.clone()];
    people.sort();
    let mut told = outcome.member_account_ids.clone();
    told.sort();
    assert_eq!(told, people);
    assert!(store::group_space_closed(&pool, &space).await.unwrap());
    assert!(store::session_conversation_closed(&pool, &space)
        .await
        .unwrap());

    for conversation_id in [group.id, channel.id] {
        assert!(
            active_people(&pool, conversation_id).await >= 3,
            "everyone stays a member"
        );
        for person in &people {
            assert!(
                removal_events(&pool, person, conversation_id)
                    .await
                    .is_empty(),
                "{person} keeps {conversation_id}"
            );
            let events = close_events(&pool, person, conversation_id).await;
            assert_eq!(events.len(), 1, "{person} is told {conversation_id} closed");
            assert_eq!(events[0]["closed_by_account_id"], json!(admin));
        }
    }
    // History stays readable for every member, and sync carries the state.
    for person in &people {
        let page = store::history(&pool, person, group.id, None, None)
            .await
            .unwrap();
        assert!(page.messages.iter().any(|message| message.id == hello.id));
        let snapshot = store::bootstrap(&pool, person).await.unwrap();
        for conversation in snapshot
            .conversations
            .iter()
            .filter(|conversation| expected.contains(&conversation.id))
        {
            let closed = conversation.closed.as_ref().expect("bootstrap says closed");
            assert_eq!(closed.closed_by_account_id.as_deref(), Some(admin.as_str()));
        }
        assert_eq!(
            snapshot
                .conversations
                .iter()
                .filter(|conversation| expected.contains(&conversation.id))
                .count(),
            2
        );
    }
    let live_links: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_group_invitations WHERE group_space_id = $1 AND revoked_at IS NULL",
    )
    .bind(&space)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(live_links.0, 0);

    // Nothing new is written.
    assert_eq!(
        closed_code(store::send_message(&pool, &owner, group.id, text("after")).await),
        store::GROUP_CLOSED_CODE
    );
    assert_eq!(
        closed_code(store::send_message(&pool, &member, channel.id, text("after")).await),
        store::GROUP_CLOSED_CODE
    );
    assert_eq!(
        closed_code(store::set_reaction(&pool, &owner, group.id, hello.id, "👍", true).await),
        store::GROUP_CLOSED_CODE
    );
    assert_eq!(
        closed_code(
            store::edit_message(
                &pool,
                &member,
                group.id,
                hello.id,
                UpdateMessageRequest {
                    expected_version: hello.version,
                    text: "edited".into(),
                },
            )
            .await
        ),
        store::GROUP_CLOSED_CODE
    );
    assert_eq!(
        closed_code(
            store::add_conversation_members(
                &pool,
                &owner,
                group.id,
                AddConversationMembersRequest {
                    client_operation_id: Uuid::now_v7(),
                    member_account_ids: vec![outsider.clone()],
                    replace: false,
                },
            )
            .await
        ),
        store::GROUP_CLOSED_CODE
    );
    assert_eq!(
        closed_code(
            store::create_group_channel(
                &pool,
                &owner,
                &space,
                group_request(vec![], Some("Synthetic late channel")),
            )
            .await
        ),
        store::GROUP_CLOSED_CODE
    );
    assert_eq!(
        closed_code(
            store::update_shared_title(
                &pool,
                &owner,
                group.id,
                UpdateConversationTitleRequest {
                    client_operation_id: Uuid::now_v7(),
                    expected_version: 1,
                    shared_title: Some("Renamed".into()),
                },
            )
            .await
        ),
        store::GROUP_CLOSED_CODE
    );

    // Closing again changes nothing and tells nobody.
    let again = store::dissolve_group(&pool, &owner, &space).await.unwrap();
    assert!(again.member_account_ids.is_empty());
    assert_eq!(close_events(&pool, &member, group.id).await.len(), 1);
}

#[tokio::test]
async fn closing_a_channel_leaves_the_group_open() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "channel-close-owner").await;
    let member = account(&pool, "channel-close-member").await;
    connect_accounts(&pool, &owner, &member).await;
    let group =
        store::create_conversation(&pool, &owner, group_request(vec![member.clone()], None))
            .await
            .unwrap()
            .value;
    let space = group.legacy_session_id.clone().unwrap();
    let channel = store::create_group_channel(
        &pool,
        &owner,
        &space,
        group_request(vec![], Some("Synthetic QA channel")),
    )
    .await
    .unwrap()
    .value;

    assert!(matches!(
        store::dissolve_group_channel(&pool, &member, &space, channel.id).await,
        Err(StoreError::Forbidden)
    ));
    assert!(
        matches!(
            store::dissolve_group_channel(&pool, &owner, &space, group.id).await,
            Err(StoreError::InvalidInput(_))
        ),
        "the first channel is the group"
    );
    assert!(matches!(
        store::dissolve_group_channel(&pool, &owner, &format!("{space}-other"), channel.id).await,
        Err(StoreError::NotFound)
    ));

    let outcome = store::dissolve_group_channel(&pool, &owner, &space, channel.id)
        .await
        .unwrap();
    assert_eq!(outcome.conversation_ids, vec![channel.id]);
    for person in [&owner, &member] {
        assert!(removal_events(&pool, person, channel.id).await.is_empty());
        assert_eq!(close_events(&pool, person, channel.id).await.len(), 1);
        assert!(close_events(&pool, person, group.id).await.is_empty());
    }
    assert!(store::conversation_is_closed(&pool, channel.id)
        .await
        .unwrap());
    assert!(!store::conversation_is_closed(&pool, group.id)
        .await
        .unwrap());
    assert!(!store::group_space_closed(&pool, &space).await.unwrap());
    assert_eq!(
        closed_code(store::send_message(&pool, &member, channel.id, text("late")).await),
        store::GROUP_CLOSED_CODE
    );
    store::send_message(&pool, &member, group.id, text("still open"))
        .await
        .expect("the group itself stays open");
}

#[tokio::test]
async fn anyone_leaves_a_closed_group_even_its_last_admin() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "Gil").await;
    let member = account(&pool, "Hal").await;
    connect_accounts(&pool, &owner, &member).await;
    let group =
        store::create_conversation(&pool, &owner, group_request(vec![member.clone()], None))
            .await
            .unwrap()
            .value;
    let space = group.legacy_session_id.clone().unwrap();
    store::dissolve_group(&pool, &owner, &space).await.unwrap();
    let before = store::history(&pool, &member, group.id, None, None)
        .await
        .unwrap()
        .messages
        .len();

    // The only admin leaves without handing over, and nothing is posted.
    let outcome = store::leave_group(&pool, &owner, &space).await.unwrap();
    assert_eq!(outcome.conversation_ids, vec![group.id]);
    assert_eq!(
        removal_events(&pool, &owner, group.id).await,
        vec!["left".to_string()]
    );
    assert!(matches!(
        store::history(&pool, &owner, group.id, None, None).await,
        Err(StoreError::Forbidden)
    ));
    assert_eq!(
        store::history(&pool, &member, group.id, None, None)
            .await
            .unwrap()
            .messages
            .len(),
        before
    );
    // The last person leaves too.
    store::leave_group(&pool, &member, &space).await.unwrap();
    assert_eq!(
        removal_events(&pool, &member, group.id).await,
        vec!["left".to_string()]
    );
}
