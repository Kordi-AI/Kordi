//! Ask to join a group started from a room: the request card in the group,
//! approving, declining, withdrawing, and what the room shows.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::db_fixture::{pool, send, signed_in};
use super::support::{make_contacts, people_in_a_room};
use crate::system_account::SYSTEM_ACCOUNT_ID;

/// A room with Alex, Priya, Sam and Dana, and a group Alex started there:
/// Priya (a contact) is a member, Dana is invited, Sam is neither.
struct Setup {
    app: axum::Router,
    pool: PgPool,
    code: String,
    group: Value,
    alex: (String, String),
    priya: (String, String),
    sam: (String, String),
    dana: (String, String),
}

async fn setup() -> Option<Setup> {
    let pool = pool().await?;
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Sam", "Dana"]).await;
    let [alex, priya, sam, dana] = [
        people[0].clone(),
        people[1].clone(),
        people[2].clone(),
        people[3].clone(),
    ];
    make_contacts(&pool, &alex.0, &priya.0).await;
    let (status, body) = send(
        &app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/group"),
        &alex.1,
        Some(json!({"name": "Agent memory", "memberIds": [priya.0, dana.0]})),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    Some(Setup {
        app,
        pool,
        code,
        group: body["group"].clone(),
        alex,
        priya,
        sam,
        dana,
    })
}

impl Setup {
    fn space(&self) -> &str {
        self.group["groupSpaceId"].as_str().unwrap()
    }

    fn conversation(&self) -> Uuid {
        self.group["conversationId"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap()
    }

    async fn ask(&self, token: &str) -> (u16, Value) {
        self.ask_for(token, self.space()).await
    }

    async fn ask_for(&self, token: &str, space: &str) -> (u16, Value) {
        send(
            &self.app,
            "POST",
            &format!("/v1/cloud/common-ground/rooms/{}/join-requests", self.code),
            token,
            Some(json!({ "groupSpaceId": space })),
        )
        .await
    }

    async fn decide(&self, token: &str, request_id: &Value, action: &str) -> (u16, Value) {
        send(
            &self.app,
            "POST",
            &format!(
                "/v1/cloud/common-ground/join-requests/{}",
                request_id.as_str().unwrap()
            ),
            token,
            Some(json!({ "action": action })),
        )
        .await
    }

    async fn cancel(&self, token: &str, request_id: &Value) -> (u16, Value) {
        send(
            &self.app,
            "DELETE",
            &format!(
                "/v1/cloud/common-ground/rooms/{}/join-requests/{}",
                self.code,
                request_id.as_str().unwrap()
            ),
            token,
            None,
        )
        .await
    }

    async fn read(&self, token: &str, request_id: &Value) -> (u16, Value) {
        send(
            &self.app,
            "GET",
            &format!(
                "/v1/cloud/common-ground/join-requests/{}",
                request_id.as_str().unwrap()
            ),
            token,
            None,
        )
        .await
    }

    /// The group as `token`'s room view shows it.
    async fn group_in_room(&self, token: &str) -> Value {
        let (status, room) = send(
            &self.app,
            "GET",
            &format!("/v1/cloud/common-ground/rooms/{}", self.code),
            token,
            None,
        )
        .await;
        assert_eq!(status, 200, "{room}");
        room["groups"]
            .as_array()
            .unwrap()
            .iter()
            .find(|group| group["groupSpaceId"] == self.space())
            .cloned()
            .unwrap()
    }

    /// (sender, kind, content) of the request's card message.
    async fn card(&self, request_id: &Value) -> (String, String, Value) {
        let id: Uuid = request_id.as_str().unwrap().parse().unwrap();
        query_as(
            "SELECT message.sender_account_id, message.message_kind, message.content
             FROM cloud_common_ground_room_join_requests request
             JOIN cloud_chat_messages message ON message.message_id = request.message_id
             WHERE request.request_id = $1",
        )
        .bind(id)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    async fn is_member(&self, account: &str) -> bool {
        let (member,): (bool,) = query_as(
            "SELECT EXISTS (SELECT 1 FROM cloud_chat_conversation_members
                            WHERE conversation_id = $1 AND account_id = $2
                              AND membership_state = 'active')",
        )
        .bind(self.conversation())
        .bind(account)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        member
    }
}

fn block(content: &Value) -> Value {
    content["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|block| block["type"] == "group_join_request")
        .cloned()
        .unwrap()
}

#[tokio::test]
async fn asking_posts_a_card_and_the_owner_approves() {
    let Some(s) = setup().await else {
        return;
    };
    let (sam, sam_token) = s.sam.clone();
    let before = s.group_in_room(&sam_token).await;
    assert_eq!(before["canAskToJoin"], true);
    assert_eq!(before["joinRequest"], Value::Null);
    assert_eq!(before["requests"], json!([]));

    let (status, body) = s.ask(&sam_token).await;
    assert_eq!(status, 201, "{body}");
    let request = body["request"].clone();
    let request_id = request["requestId"].clone();
    assert_eq!(request["type"], "group_join_request");
    assert_eq!(request["status"], "pending");
    assert_eq!(request["requester"]["accountId"], sam.as_str());
    assert_eq!(request["groupSpaceId"], s.space());
    assert_eq!(request["groupName"], "Agent memory");
    assert_eq!(request["approverIds"], json!([s.alex.0]));
    assert_eq!(request["decidedBy"], Value::Null);
    assert_eq!(request["revision"], 1);

    let (sender, kind, content) = s.card(&request_id).await;
    assert_eq!(sender, SYSTEM_ACCOUNT_ID);
    assert_eq!(kind, "system-notice");
    assert_eq!(content["blocks"][0]["text"], "Sam asked to join.");
    assert_eq!(block(&content)["status"], "pending");
    assert_eq!(block(&content)["requestId"], request_id);

    let (status, again) = s.ask(&sam_token).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["request"]["requestId"], request_id);

    for (token, expected) in [(&sam_token, 200), (&s.alex.1, 200), (&s.priya.1, 200)] {
        let (status, body) = s.read(token, &request_id).await;
        assert_eq!(status, expected, "{body}");
        assert_eq!(body["request"]["requestId"], request_id);
    }
    let (status, _) = s.read(&s.dana.1, &request_id).await;
    assert_eq!(status, 404, "an invited non-member does not see it");

    let mine = s.group_in_room(&sam_token).await;
    assert_eq!(mine["joinRequest"]["status"], "pending");
    assert_eq!(mine["joinRequest"]["requestId"], request_id);
    assert_eq!(mine["canAskToJoin"], false);
    assert_eq!(mine["requests"], json!([]));
    let owners = s.group_in_room(&s.alex.1).await;
    assert_eq!(owners["requests"][0]["requestId"], request_id);
    assert_eq!(owners["requests"][0]["person"]["accountId"], sam.as_str());
    assert_eq!(owners["canAskToJoin"], false);
    let members = s.group_in_room(&s.priya.1).await;
    assert_eq!(
        members["requests"],
        json!([]),
        "only approvers see requests"
    );

    let (status, body) = s.decide(&s.priya.1, &request_id, "approve").await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["errorCode"], "common_ground_join_request_forbidden");
    let (status, body) = s.decide(&s.alex.1, &request_id, "maybe").await;
    assert_eq!(status, 400, "{body}");

    let (status, body) = s.decide(&s.alex.1, &request_id, "approve").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["request"]["status"], "approved");
    assert_eq!(body["request"]["decidedBy"]["accountId"], s.alex.0.as_str());
    assert_eq!(body["request"]["revision"], 2);
    assert!(s.is_member(&sam).await);

    let (acceptances,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_group_invitation_acceptances acceptance
         JOIN cloud_group_invitations invite ON invite.invitation_id = acceptance.invitation_id
         WHERE invite.group_space_id = $1 AND acceptance.account_id = $2",
    )
    .bind(s.space())
    .bind(&sam)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(acceptances, 1);
    let (accepted,): (bool,) = query_as(
        "SELECT accepted_at IS NOT NULL FROM cloud_common_ground_room_invitations
         WHERE group_space_id = $1 AND invitee_account_id = $2",
    )
    .bind(s.space())
    .bind(&sam)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert!(accepted);
    let (audits,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_audit_events
         WHERE account_id = $1 AND event_type = 'group.invitation.accepted'",
    )
    .bind(&sam)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(audits, 1);
    let joined_line = Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("common-ground-joined:{}:{sam}", s.conversation()).as_bytes(),
    );
    let lines: Vec<(String, String, Value)> = query_as(
        "SELECT sender_account_id, message_kind, content FROM cloud_chat_messages
         WHERE conversation_id = $1 AND client_message_id = $2",
    )
    .bind(s.conversation())
    .bind(joined_line)
    .fetch_all(&s.pool)
    .await
    .unwrap();
    assert_eq!(lines.len(), 1, "one joined line");
    assert_eq!(lines[0].0, SYSTEM_ACCOUNT_ID);
    assert_eq!(lines[0].1, "system-notice");
    // The line is a mention envelope around "@Sam joined. …".
    let text = lines[0].2["blocks"][0]["text"].as_str().unwrap();
    let encoded = text.strip_prefix("kordi-cloud-message:").unwrap();
    let envelope: Value = serde_json::from_slice(
        &base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).unwrap(),
    )
    .unwrap();
    assert!(
        envelope["text"]
            .as_str()
            .unwrap()
            .starts_with("@Sam joined."),
        "{envelope}"
    );

    let (_, _, content) = s.card(&request_id).await;
    assert_eq!(block(&content)["status"], "approved");
    assert_eq!(block(&content)["revision"], 2);

    let now = s.group_in_room(&sam_token).await;
    assert_eq!(now["joined"], true);
    assert_eq!(now["canAskToJoin"], false);
    assert_eq!(now["joinRequest"]["status"], "approved");
    assert_eq!(s.group_in_room(&s.alex.1).await["requests"], json!([]));

    let (status, body) = s.decide(&s.alex.1, &request_id, "decline").await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["errorCode"], "common_ground_join_request_closed");
    assert_eq!(body["request"]["status"], "approved");
    let (status, body) = s.ask(&sam_token).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["errorCode"], "common_ground_already_member");
}

#[tokio::test]
async fn asking_is_refused_outside_the_room_for_members_and_invitees() {
    let Some(s) = setup().await else {
        return;
    };
    let (_, carol_token) = signed_in(&s.pool, "Carol").await;
    let (status, body) = s.ask(&carol_token).await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(body["errorCode"], "common_ground_room_not_found");

    let (status, body) = s.ask(&s.priya.1).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["errorCode"], "common_ground_already_member");

    let (status, body) = s.ask(&s.dana.1).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["errorCode"], "common_ground_already_invited");
    assert_eq!(s.group_in_room(&s.dana.1).await["canAskToJoin"], false);

    let (status, body) = s.ask_for(&s.sam.1, "session:group:unknown").await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(body["errorCode"], "common_ground_group_not_found");

    query(
        "INSERT INTO cloud_account_blocks (blocker_account_id, blocked_account_id) VALUES ($1, $2)",
    )
    .bind(&s.priya.0)
    .bind(&s.sam.0)
    .execute(&s.pool)
    .await
    .unwrap();
    let (status, body) = s.ask(&s.sam.1).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["message"], "You can't join this group.");
    assert!(!body.to_string().contains("Priya"), "{body}");
}

#[tokio::test]
async fn a_closed_room_takes_no_requests() {
    let Some(s) = setup().await else {
        return;
    };
    query("UPDATE cloud_common_ground_rooms SET closed_at = now() WHERE code = $1 AND closed_at IS NULL")
        .bind(&s.code)
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(s.group_in_room(&s.sam.1).await["canAskToJoin"], false);
    let (status, body) = s.ask(&s.sam.1).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["errorCode"], "common_ground_room_closed");
    assert_eq!(body["message"], "This room has closed.");
}

#[tokio::test]
async fn a_declined_request_cannot_be_sent_again() {
    let Some(s) = setup().await else {
        return;
    };
    let (status, body) = s.ask(&s.sam.1).await;
    assert_eq!(status, 201, "{body}");
    let request_id = body["request"]["requestId"].clone();
    let (status, body) = s.decide(&s.alex.1, &request_id, "decline").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["request"]["status"], "declined");
    assert_eq!(body["request"]["decidedBy"]["accountId"], s.alex.0.as_str());
    assert!(!s.is_member(&s.sam.0).await);
    let (_, _, content) = s.card(&request_id).await;
    assert_eq!(block(&content)["status"], "declined");

    let (status, body) = s.ask(&s.sam.1).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["errorCode"], "common_ground_join_request_declined");
    let group = s.group_in_room(&s.sam.1).await;
    assert_eq!(group["canAskToJoin"], false);
    assert_eq!(group["joinRequest"]["status"], "declined");
    assert_eq!(s.group_in_room(&s.alex.1).await["requests"], json!([]));
}

#[tokio::test]
async fn the_requester_withdraws_and_may_ask_again() {
    let Some(s) = setup().await else {
        return;
    };
    let (status, body) = s.ask(&s.sam.1).await;
    assert_eq!(status, 201, "{body}");
    let request_id = body["request"]["requestId"].clone();

    let (status, body) = s.cancel(&s.priya.1, &request_id).await;
    assert_eq!(status, 404, "only the requester withdraws: {body}");
    let (status, body) = s.cancel(&s.sam.1, &request_id).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["request"]["status"], "cancelled");
    assert_eq!(body["request"]["revision"], 2);
    let (_, _, content) = s.card(&request_id).await;
    assert_eq!(block(&content)["status"], "cancelled");
    let (status, body) = s.cancel(&s.sam.1, &request_id).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["errorCode"], "common_ground_join_request_closed");
    assert_eq!(body["request"]["status"], "cancelled");
    let (status, body) = s.decide(&s.alex.1, &request_id, "approve").await;
    assert_eq!(status, 409, "{body}");

    let group = s.group_in_room(&s.sam.1).await;
    assert_eq!(group["joinRequest"]["status"], "cancelled");
    assert_eq!(group["canAskToJoin"], true);
    let (status, body) = s.ask(&s.sam.1).await;
    assert_eq!(status, 201, "{body}");
    assert_ne!(body["request"]["requestId"], request_id);
    assert_eq!(body["request"]["status"], "pending");
}

#[tokio::test]
async fn approving_after_the_requester_left_the_room_withdraws_it() {
    let Some(s) = setup().await else {
        return;
    };
    let (status, body) = s.ask(&s.sam.1).await;
    assert_eq!(status, 201, "{body}");
    let request_id = body["request"]["requestId"].clone();
    let (status, _) = send(
        &s.app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{}/leave", s.code),
        &s.sam.1,
        None,
    )
    .await;
    assert_eq!(status, 204);
    assert_eq!(s.group_in_room(&s.alex.1).await["requests"], json!([]));
    let (status, body) = s.decide(&s.alex.1, &request_id, "approve").await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["request"]["status"], "cancelled");
    assert!(!s.is_member(&s.sam.0).await);
}

#[tokio::test]
async fn a_person_who_left_the_group_is_added_back_on_approval() {
    let Some(s) = setup().await else {
        return;
    };
    let (status, body) = s.ask(&s.sam.1).await;
    assert_eq!(status, 201, "{body}");
    let (status, body) = s
        .decide(&s.alex.1, &body["request"]["requestId"], "approve")
        .await;
    assert_eq!(status, 200, "{body}");
    assert!(s.is_member(&s.sam.0).await);

    // Sam leaves the group; the link still records them as having joined.
    query(
        "UPDATE cloud_chat_conversation_members
         SET membership_state = 'left', left_at = now()
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(s.conversation())
    .bind(&s.sam.0)
    .execute(&s.pool)
    .await
    .unwrap();
    assert!(!s.is_member(&s.sam.0).await);
    assert_eq!(s.group_in_room(&s.sam.1).await["canAskToJoin"], true);

    let (status, body) = s.ask(&s.sam.1).await;
    assert_eq!(status, 201, "{body}");
    let (status, body) = s
        .decide(&s.alex.1, &body["request"]["requestId"], "approve")
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["request"]["status"], "approved");
    assert!(s.is_member(&s.sam.0).await);
}
