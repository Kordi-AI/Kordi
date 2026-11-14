//! A room with a group started from it, and helpers for the join request
//! tests.

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::db_fixture::{pool, send};
use super::support::{make_contacts, people_in_a_room};

/// A room with Alex, Priya, Sam and Dana, and a group Alex started there:
/// Priya (a contact) is a member, Dana is invited, Sam is neither.
pub(super) struct Setup {
    pub(super) app: axum::Router,
    pub(super) pool: PgPool,
    pub(super) code: String,
    pub(super) group: Value,
    pub(super) alex: (String, String),
    pub(super) priya: (String, String),
    pub(super) sam: (String, String),
    pub(super) dana: (String, String),
}

pub(super) async fn setup() -> Option<Setup> {
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
    pub(super) fn space(&self) -> &str {
        self.group["groupSpaceId"].as_str().unwrap()
    }

    pub(super) fn conversation(&self) -> Uuid {
        self.group["conversationId"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap()
    }

    pub(super) async fn ask(&self, token: &str) -> (u16, Value) {
        self.ask_for(token, self.space()).await
    }

    pub(super) async fn ask_for(&self, token: &str, space: &str) -> (u16, Value) {
        send(
            &self.app,
            "POST",
            &format!("/v1/cloud/common-ground/rooms/{}/join-requests", self.code),
            token,
            Some(json!({ "groupSpaceId": space })),
        )
        .await
    }

    pub(super) async fn decide(
        &self,
        token: &str,
        request_id: &Value,
        action: &str,
    ) -> (u16, Value) {
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

    pub(super) async fn cancel(&self, token: &str, request_id: &Value) -> (u16, Value) {
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

    pub(super) async fn read(&self, token: &str, request_id: &Value) -> (u16, Value) {
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
    pub(super) async fn group_in_room(&self, token: &str) -> Value {
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
    pub(super) async fn card(&self, request_id: &Value) -> (String, String, Value) {
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

    pub(super) async fn is_member(&self, account: &str) -> bool {
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

pub(super) fn block(content: &Value) -> Value {
    content["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|block| block["type"] == "group_join_request")
        .cloned()
        .unwrap()
}
