use super::*;

pub(super) fn group_request(
    members: Vec<String>,
    title: Option<&str>,
) -> CreateConversationRequest {
    CreateConversationRequest {
        client_operation_id: Uuid::now_v7(),
        kind: ConversationKind::Group,
        shared_title: title.map(str::to_string),
        client_session_id: format!("session:group:{}", Uuid::now_v7()),
        member_account_ids: members,
        organization_id: None,
    }
}

pub(super) async fn removal_events(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
) -> Vec<String> {
    query_as::<_, (serde_json::Value,)>(
        "SELECT payload FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND conversation_id = $2 AND event_type = 'membership.removed'",
    )
    .bind(account_id)
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|(payload,)| payload["reason"].as_str().unwrap_or_default().to_string())
    .collect()
}

pub(super) async fn active_people(pool: &PgPool, conversation_id: Uuid) -> i64 {
    query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND membership_state = 'active'",
    )
    .bind(conversation_id)
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}

#[tokio::test]
async fn a_new_group_opens_with_who_created_it_for_everyone() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "Ava").await;
    let member = account(&pool, "Ben").await;
    connect_accounts(&pool, &owner, &member).await;
    let created =
        store::create_conversation(&pool, &owner, group_request(vec![member.clone()], None))
            .await
            .unwrap();
    assert!(created.inserted);

    for viewer in [&owner, &member] {
        let page = store::history(&pool, viewer, created.value.id, None, None)
            .await
            .unwrap();
        let notices: Vec<_> = page
            .messages
            .iter()
            .filter(|message| message.kind == "system-notice")
            .collect();
        assert_eq!(notices.len(), 1, "one created line for {viewer}");
        let notice = notices[0];
        assert_eq!(
            notice.conversation_sequence, 1,
            "the created line comes first"
        );
        assert_eq!(notice.sender_account_id, owner);
        assert_eq!(notice.content["blocks"][0]["text"], "Ava created the group");
        assert_eq!(
            notice.content["group_event"]["type"],
            store::GROUP_CREATED_EVENT
        );
        assert_eq!(
            notice.content["group_event"]["actor_account_id"],
            owner.as_str()
        );
    }

    // Opening the same group again posts nothing new.
    let mut replay = group_request(vec![member.clone()], None);
    replay.client_session_id = created.value.legacy_session_id.clone().unwrap();
    let replayed = store::create_conversation(&pool, &owner, replay)
        .await
        .unwrap();
    assert!(!replayed.inserted);
    let page = store::history(&pool, &owner, created.value.id, None, None)
        .await
        .unwrap();
    assert_eq!(
        page.messages
            .iter()
            .filter(|message| message.kind == "system-notice")
            .count(),
        1
    );

    // A direct chat gets no created line.
    let other = account(&pool, "Cal").await;
    connect_accounts(&pool, &owner, &other).await;
    let direct = store::create_conversation(
        &pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: direct_person_session_id(&owner, &other),
            member_account_ids: vec![other.clone()],
            organization_id: None,
        },
    )
    .await
    .unwrap();
    let page = store::history(&pool, &owner, direct.value.id, None, None)
        .await
        .unwrap();
    assert!(page.messages.is_empty());
}
