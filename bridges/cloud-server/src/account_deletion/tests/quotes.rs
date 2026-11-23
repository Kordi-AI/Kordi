//! Quote, forward and thread references (`messageAction.source`) to a
//! deleted account's messages name the stand-in, in kept groups and kept
//! direct conversations, and keep pointing at their own conversation.

use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

const GROUP_PREFIX: &str = "kordi-cloud-group:";
const DIRECT_PREFIX: &str = "kordi-cloud-message:";

fn encoded(prefix: &str, value: &Value) -> Value {
    text(&format!(
        "{prefix}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap())
    ))
}

fn decoded(prefix: &str, content: &Value) -> Value {
    let text = content["blocks"][0]["text"].as_str().unwrap();
    let encoded = text.strip_prefix(prefix).expect("an envelope");
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap()
}

fn quote(source_message_id: &str, session_id: &str, label: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "kind": "quote",
        "source": {
            "sourceSessionId": session_id,
            "sourceMessageId": source_message_id,
            "sourceMessageKind": "text",
            "senderLabel": label,
            "textPreview": "Also, the studio moved",
            "attachmentCount": 0
        }
    })
}

fn group_message(
    group: &str,
    sender: (&str, &str),
    people: &[(&str, &str)],
    id: &str,
    text: &str,
    action: Option<Value>,
) -> Value {
    json!({
        "kind": "message",
        "groupId": group,
        "groupTitle": "Studio crew",
        "createdByAccountId": people[0].0,
        "actor": {"accountId": sender.0, "displayName": sender.1},
        "participants": people.iter()
            .map(|(id, name)| json!({"accountId": id, "displayName": name}))
            .collect::<Vec<_>>(),
        "message": {
            "id": id,
            "senderAccountId": sender.0,
            "senderDisplayName": sender.1,
            "text": text,
            "messageAction": action,
        }
    })
}

async fn group(pool: &PgPool, members: &[(&str, &str)]) -> Uuid {
    let id = Uuid::new_v4();
    query(
        "INSERT INTO cloud_chat_conversations \
         (conversation_id, kind, created_by_account_id, client_operation_id, \
          creation_fingerprint) VALUES ($1, 'group', $2, $3, 'test')",
    )
    .bind(id)
    .bind(members[0].0)
    .bind(Uuid::new_v4())
    .execute(pool)
    .await
    .unwrap();
    for (offset, (member, role)) in members.iter().enumerate() {
        query(
            "INSERT INTO cloud_chat_conversation_members \
             (conversation_id, account_id, role, joined_at) \
             VALUES ($1, $2, $3, now() - make_interval(mins => $4))",
        )
        .bind(id)
        .bind(member)
        .bind(role)
        .bind(100 - offset as i32)
        .execute(pool)
        .await
        .unwrap();
    }
    id
}

async fn content_of(pool: &PgPool, message_id: Uuid) -> Value {
    query_as::<_, (Value,)>("SELECT content FROM cloud_chat_messages WHERE message_id = $1")
        .bind(message_id)
        .fetch_one(pool)
        .await
        .unwrap()
        .0
}

#[tokio::test]
async fn a_kept_group_names_the_stand_in_in_quotes_of_the_deleted_persons_messages() {
    let Some(pool) = pool().await else { return };
    let (gone, _) = person(&pool, "Maya Sample").await;
    let (rowan, _) = person(&pool, "Rowan Sample").await;
    let (kim, _) = person(&pool, "Kim Sample").await;
    let conversation = group(
        &pool,
        &[(&gone, "owner"), (&rowan, "member"), (&kim, "admin")],
    )
    .await;
    let people = [
        (gone.as_str(), "Maya Sample"),
        (rowan.as_str(), "Rowan Sample"),
        (kim.as_str(), "Kim Sample"),
    ];
    let session = conversation.to_string();
    let from_gone = send(
        &pool,
        &gone,
        conversation,
        encoded(
            GROUP_PREFIX,
            &group_message(
                &session,
                people[0],
                &people,
                "env-gone-1",
                "Also, the studio moved",
                None,
            ),
        ),
    )
    .await
    .unwrap();
    let from_kim = send(
        &pool,
        &kim,
        conversation,
        encoded(
            GROUP_PREFIX,
            &group_message(&session, people[2], &people, "env-kim-1", "Noted", None),
        ),
    )
    .await
    .unwrap();
    // Rowan quotes Maya by stored id and by envelope id, and Kim by id.
    let mut replies = Vec::new();
    for (source, label) in [
        (from_gone.to_string(), "Maya Sample"),
        ("env-gone-1".to_string(), "Maya Sample"),
        (from_kim.to_string(), "Kim Sample"),
    ] {
        let reply = send(
            &pool,
            &rowan,
            conversation,
            encoded(
                GROUP_PREFIX,
                &group_message(
                    &session,
                    people[1],
                    &people,
                    &format!("env-rowan-{}", replies.len()),
                    "Thanks",
                    Some(quote(&source, &session, label)),
                ),
            ),
        )
        .await
        .unwrap();
        replies.push(reply);
    }

    // The person deletes their own account; the group is kept.
    let deletion = delete(&pool, &gone, DirectConversations::Empty).await;
    assert_eq!(deletion.conversations.kept, 1);

    for (reply, expected) in
        replies
            .iter()
            .zip(["Deleted account", "Deleted account", "Kim Sample"])
    {
        let envelope = decoded(GROUP_PREFIX, &content_of(&pool, *reply).await);
        let source = &envelope["message"]["messageAction"]["source"];
        assert_eq!(source["senderLabel"], expected, "{envelope}");
        assert_eq!(source["sourceSessionId"], session.as_str());
        assert_eq!(
            source["textPreview"], "Also, the studio moved",
            "free text stays"
        );
        assert_eq!(envelope["message"]["senderDisplayName"], "Rowan Sample");
        assert!(!envelope.to_string().contains("Maya Sample"), "{envelope}");
    }
}

#[tokio::test]
async fn a_kept_direct_chat_quote_names_the_stand_in_and_still_leads_to_the_chat() {
    let Some(pool) = pool().await else { return };
    let (gone, _) = person(&pool, "Maya Sample").await;
    let (rowan, _) = person(&pool, "Rowan Sample").await;
    let conversation = direct_conversation(&pool, &gone, &rowan).await;
    let (session,): (String,) = query_as(
        "SELECT legacy_session_id FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(conversation)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(session.contains(&gone), "the session id names both people");
    let from_gone = send(&pool, &gone, conversation, text("Also, the studio moved"))
        .await
        .unwrap();
    let reply = send(
        &pool,
        &rowan,
        conversation,
        encoded(
            DIRECT_PREFIX,
            &json!({
                "schemaVersion": 1,
                "kind": "message",
                "text": "Thanks for the heads-up",
                "messageAction": quote(&from_gone.to_string(), &session, "Maya Sample"),
            }),
        ),
    )
    .await
    .unwrap();

    // An operator deletes the account; Rowan keeps the conversation.
    let deletion = delete(&pool, &gone, DirectConversations::Keep).await;
    assert_eq!(deletion.conversations.direct_kept, 1);

    let (session_after,): (String,) = query_as(
        "SELECT legacy_session_id FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(conversation)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        session_after, session,
        "the conversation keeps its session id"
    );
    let envelope = decoded(DIRECT_PREFIX, &content_of(&pool, reply).await);
    let source = &envelope["messageAction"]["source"];
    assert_eq!(source["senderLabel"], "Deleted account", "{envelope}");
    assert_eq!(source["sourceMessageId"], from_gone.to_string());
    assert_eq!(
        source["sourceSessionId"],
        session_after.as_str(),
        "jump-to-message still finds the conversation"
    );
    assert_eq!(envelope["text"], "Thanks for the heads-up");
}
