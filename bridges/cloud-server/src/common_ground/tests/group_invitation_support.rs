//! A room with a group Alex started there, and helpers for the tests that
//! invite Grounding people into groups.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::db_fixture::{pool, send};
use super::support::{make_contacts, people_in_a_room};

const CG: &str = "/v1/cloud/common-ground";

/// A room with Alex, Priya, Sam, Dana and Eli, and a group Alex (owner)
/// started there with Priya (a contact) as its only other member. Nobody is
/// invited to it yet.
pub(super) struct Setup {
    pub(super) app: axum::Router,
    pub(super) pool: PgPool,
    pub(super) code: String,
    pub(super) room_name: String,
    pub(super) group: Value,
    pub(super) alex: (String, String),
    pub(super) priya: (String, String),
    pub(super) sam: (String, String),
    pub(super) dana: (String, String),
    pub(super) eli: (String, String),
}

pub(super) async fn setup() -> Option<Setup> {
    let pool = pool().await?;
    let (app, code, people) =
        people_in_a_room(&pool, &["Alex", "Priya", "Sam", "Dana", "Eli"]).await;
    let [alex, priya, sam, dana, eli] = [
        people[0].clone(),
        people[1].clone(),
        people[2].clone(),
        people[3].clone(),
        people[4].clone(),
    ];
    make_contacts(&pool, &alex.0, &priya.0).await;
    let (status, body) = send(
        &app,
        "POST",
        &format!("{CG}/rooms/{code}/group"),
        &alex.1,
        Some(json!({"name": "Infrastructure and CI", "memberIds": [priya.0]})),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let (room_name,): (String,) = query_as(
        "SELECT name FROM cloud_common_ground_rooms WHERE code = $1 AND closed_at IS NULL",
    )
    .bind(&code)
    .fetch_one(&pool)
    .await
    .unwrap();
    Some(Setup {
        app,
        pool,
        code,
        room_name,
        group: body["group"].clone(),
        alex,
        priya,
        sam,
        dana,
        eli,
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

    pub(super) async fn invite(&self, token: &str, ids: &[&String]) -> (u16, Value) {
        send(
            &self.app,
            "POST",
            &format!("{CG}/group-invitations"),
            token,
            Some(json!({ "groupSpaceId": self.space(), "accountIds": ids })),
        )
        .await
    }

    /// The viewer's invitations in Contacts › Requests.
    pub(super) async fn pending(&self, token: &str) -> Vec<Value> {
        let (status, body) =
            send(&self.app, "GET", &format!("{CG}/invitations"), token, None).await;
        assert_eq!(status, 200, "{body}");
        body["invitations"].as_array().unwrap().clone()
    }

    /// The viewer's person invitations in Contacts › Requests.
    pub(super) async fn group_pending(&self, token: &str) -> Vec<Value> {
        self.pending(token)
            .await
            .into_iter()
            .filter(|invitation| invitation["kind"] == "group")
            .collect()
    }

    pub(super) async fn answer(
        &self,
        token: &str,
        reference: &Value,
        action: &str,
    ) -> (u16, Value) {
        send(
            &self.app,
            "POST",
            &format!(
                "{CG}/group-invitations/{}/{action}",
                reference.as_str().unwrap()
            ),
            token,
            None,
        )
        .await
    }

    pub(super) async fn group_people(&self, token: &str) -> (u16, Value) {
        send(
            &self.app,
            "GET",
            &format!("{CG}/group-people?groupSpaceId={}", self.space()),
            token,
            None,
        )
        .await
    }

    pub(super) async fn person_groups(&self, token: &str, account: &str) -> (u16, Value) {
        send(
            &self.app,
            "GET",
            &format!("{CG}/people/{account}/groups"),
            token,
            None,
        )
        .await
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

    /// The statuses of every invitation to this group for `account`.
    pub(super) async fn statuses(&self, account: &str) -> Vec<String> {
        let rows: Vec<(String,)> = query_as(
            "SELECT status FROM cloud_common_ground_group_invitations
             WHERE conversation_id = $1 AND invitee_account_id = $2 ORDER BY created_at",
        )
        .bind(self.conversation())
        .bind(account)
        .fetch_all(&self.pool)
        .await
        .unwrap();
        rows.into_iter().map(|(status,)| status).collect()
    }

    /// How many `common_ground.invitations.updated` hints `account` got.
    pub(super) async fn hints(&self, account: &str) -> i64 {
        let (count,): (i64,) = query_as(
            "SELECT COUNT(*) FROM cloud_chat_user_sync_events
             WHERE account_id = $1 AND event_type = 'common_ground.invitations.updated'",
        )
        .bind(account)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        count
    }

    pub(super) async fn block(&self, blocker: &str, blocked: &str) {
        query("INSERT INTO cloud_account_blocks (blocker_account_id, blocked_account_id) VALUES ($1, $2)")
            .bind(blocker)
            .bind(blocked)
            .execute(&self.pool)
            .await
            .unwrap();
    }

    pub(super) async fn set_membership(&self, account: &str, role: &str, state: &str) {
        query(
            "UPDATE cloud_chat_conversation_members SET role = $3, membership_state = $4
             WHERE conversation_id = $1 AND account_id = $2",
        )
        .bind(self.conversation())
        .bind(account)
        .bind(role)
        .bind(state)
        .execute(&self.pool)
        .await
        .unwrap();
    }

    pub(super) async fn leave_room(&self, token: &str) {
        let (status, body) = send(
            &self.app,
            "POST",
            &format!("{CG}/rooms/{}/leave", self.code),
            token,
            None,
        )
        .await;
        assert_eq!(status, 204, "{body}");
    }

    /// An opened match from `viewer` to `other`, between their cards.
    pub(super) async fn open_match(&self, viewer: &str, other: &str) {
        query(
            "INSERT INTO cloud_common_ground_matches
                 (viewer_account_id, other_account_id, viewer_profile_id, other_profile_id,
                  viewer_revision, other_revision, result_json, opened_at)
             SELECT $1, $2, mine.profile_id, theirs.profile_id, mine.revision, theirs.revision,
                    '{}'::jsonb, now()
             FROM cloud_common_ground_cards mine, cloud_common_ground_cards theirs
             WHERE mine.account_id = $1 AND theirs.account_id = $2",
        )
        .bind(viewer)
        .bind(other)
        .execute(&self.pool)
        .await
        .unwrap();
    }
}

/// The ids of a list of person objects.
pub(super) fn ids(people: &Value) -> Vec<String> {
    people
        .as_array()
        .unwrap()
        .iter()
        .map(|person| person["accountId"].as_str().unwrap().to_string())
        .collect()
}
