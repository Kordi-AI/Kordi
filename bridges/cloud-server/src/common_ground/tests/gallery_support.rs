//! A room with Alex, Priya and Sam, artifact fixtures, and helpers for the
//! room gallery tests.

use axum::body::Body;
use axum::http::{HeaderMap, Request};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use super::db_fixture::{pool, send};
use super::support::people_in_a_room;

pub(super) const UPDATED: &str = "common_ground.gallery.updated";

pub(super) struct Setup {
    pub(super) app: axum::Router,
    pub(super) pool: PgPool,
    pub(super) code: String,
    pub(super) alex: (String, String),
    pub(super) priya: (String, String),
    pub(super) sam: (String, String),
}

pub(super) async fn setup() -> Option<Setup> {
    let pool = pool().await?;
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Sam"]).await;
    Some(Setup {
        app,
        pool,
        code,
        alex: people[0].clone(),
        priya: people[1].clone(),
        sam: people[2].clone(),
    })
}

/// A finalized attachment `owner` owns, with no stored text; returns its id.
pub(super) async fn upload(pool: &PgPool, owner: &str, content_type: &str) -> String {
    let id = format!("att_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, content_type,
             size_bytes, created_at, finalized_at)
         VALUES ($1, $2, $1, $3, 2048, $4, $4)",
    )
    .bind(&id)
    .bind(owner)
    .bind(content_type)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    id
}

/// A Kordi document `owner` owns, renamed to `title`, whose current text is
/// `source`; returns its id.
pub(super) async fn document(pool: &PgPool, owner: &str, title: &str, source: &str) -> String {
    let id = upload(pool, owner, "text/markdown").await;
    query("UPDATE cloud_attachments SET document_title = $2, size_bytes = $3 WHERE attachment_id = $1")
        .bind(&id)
        .bind(title)
        .bind(source.len() as i64)
        .execute(pool)
        .await
        .unwrap();
    query(
        "INSERT INTO cloud_document_contents (attachment_id, source, revision, updated_at)
         VALUES ($1, $2, 1, $3)",
    )
    .bind(&id)
    .bind(source)
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .unwrap();
    id
}

/// Records `attachment_id` as a document `owner`'s agent created in a run
/// that `requester` asked for.
pub(super) async fn agent_document(
    pool: &PgPool,
    attachment_id: &str,
    owner: &str,
    requester: &str,
    file_name: &str,
) {
    let run_id = format!("run_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id,
             session_id, owner_account_id, requester_account_id, status, prompt, created_at,
             updated_at)
         VALUES ($1, $1, $1, 'chat', $2, $3, 'completed', 'hi', $4, $4)",
    )
    .bind(&run_id)
    .bind(owner)
    .bind(requester)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_agent_run_documents (attachment_id, run_id, session_id,
             owner_account_id, agent_id, title, file_name, content_type, size_bytes)
         VALUES ($1, $2, 'chat', $3, 'agent', 'Agent report', $4, 'application/pdf', 10)",
    )
    .bind(attachment_id)
    .bind(&run_id)
    .bind(owner)
    .bind(file_name)
    .execute(pool)
    .await
    .unwrap();
}

async fn get_raw(app: &axum::Router, path: &str, token: &str) -> axum::response::Response {
    let request = Request::builder()
        .method("GET")
        .uri(path)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    app.clone().oneshot(request).await.unwrap()
}

/// (status, body text, content type) of a request whose answer is not JSON.
pub(super) async fn send_raw(
    app: &axum::Router,
    path: &str,
    token: &str,
) -> (u16, String, Option<String>) {
    let response = get_raw(app, path, token).await;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        String::from_utf8_lossy(&bytes).into_owned(),
        content_type,
    )
}

pub(super) fn id(value: &Value) -> String {
    value.as_str().unwrap().to_string()
}

impl Setup {
    pub(super) fn path(&self, rest: &str) -> String {
        format!("/v1/cloud/common-ground/rooms/{}/gallery{rest}", self.code)
    }

    pub(super) async fn share(
        &self,
        token: &str,
        ids: &[&str],
        topic: Option<&str>,
    ) -> (u16, Value) {
        let body = json!({ "attachmentIds": ids, "topic": topic });
        send(&self.app, "POST", &self.path(""), token, Some(body)).await
    }

    /// Shares one artifact and returns its item id.
    pub(super) async fn share_one(&self, token: &str, attachment_id: &str) -> String {
        let (status, body) = self.share(token, &[attachment_id], None).await;
        assert_eq!(status, 201, "{body}");
        id(&body["items"][0]["itemId"])
    }

    pub(super) async fn list(&self, token: &str) -> (u16, Value) {
        send(&self.app, "GET", &self.path(""), token, None).await
    }

    /// The item ids `token` sees, newest first.
    pub(super) async fn item_ids(&self, token: &str) -> Vec<String> {
        let (status, body) = self.list(token).await;
        assert_eq!(status, 200, "{body}");
        body["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| id(&item["itemId"]))
            .collect()
    }

    pub(super) async fn candidates(&self, token: &str) -> (u16, Value) {
        send(&self.app, "GET", &self.path("/candidates"), token, None).await
    }

    pub(super) async fn read(&self, token: &str, item: &str) -> (u16, Value) {
        send(
            &self.app,
            "GET",
            &self.path(&format!("/{item}")),
            token,
            None,
        )
        .await
    }

    pub(super) async fn remove(&self, token: &str, item: &str) -> (u16, Value) {
        send(
            &self.app,
            "DELETE",
            &self.path(&format!("/{item}")),
            token,
            None,
        )
        .await
    }

    pub(super) async fn content(&self, token: &str, item: &str) -> (u16, String, Option<String>) {
        send_raw(&self.app, &self.path(&format!("/{item}/content")), token).await
    }

    /// The status and headers of an item's content answer.
    pub(super) async fn content_headers(&self, token: &str, item: &str) -> (u16, HeaderMap) {
        let path = self.path(&format!("/{item}/content"));
        let response = get_raw(&self.app, &path, token).await;
        (response.status().as_u16(), response.headers().clone())
    }

    pub(super) async fn comment(&self, token: &str, item: &str, body: &str) -> (u16, Value) {
        let path = self.path(&format!("/{item}/comments"));
        send(
            &self.app,
            "POST",
            &path,
            token,
            Some(json!({ "body": body })),
        )
        .await
    }

    pub(super) async fn delete_comment(
        &self,
        token: &str,
        item: &str,
        comment: &str,
    ) -> (u16, Value) {
        let path = self.path(&format!("/{item}/comments/{comment}"));
        send(&self.app, "DELETE", &path, token, None).await
    }

    pub(super) async fn close(&self) {
        query("UPDATE cloud_common_ground_rooms SET closed_at = now() WHERE code = $1 AND closed_at IS NULL")
            .bind(&self.code)
            .execute(&self.pool)
            .await
            .unwrap();
    }

    pub(super) async fn block(&self, blocker: &str, blocked: &str) {
        query("INSERT INTO cloud_account_blocks(blocker_account_id, blocked_account_id) VALUES ($1, $2)")
            .bind(blocker)
            .bind(blocked)
            .execute(&self.pool)
            .await
            .unwrap();
    }

    /// How many hints of `event_type` `account` has.
    pub(super) async fn hints(&self, account: &str, event_type: &str) -> i64 {
        let (count,): (i64,) = query_as(
            "SELECT COUNT(*) FROM cloud_chat_user_sync_events
             WHERE account_id = $1 AND event_type = $2",
        )
        .bind(account)
        .bind(event_type)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        count
    }

    /// The payload of `account`'s latest gallery hint.
    pub(super) async fn last_hint(&self, account: &str) -> Value {
        let (payload,): (Value,) = query_as(
            "SELECT payload FROM cloud_chat_user_sync_events
             WHERE account_id = $1 AND event_type = $2 ORDER BY stream_seq DESC LIMIT 1",
        )
        .bind(account)
        .bind(UPDATED)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        payload
    }

    /// How many gallery items `account` has stored in any room.
    pub(super) async fn stored_items(&self, account: &str) -> i64 {
        let (count,): (i64,) = query_as(
            "SELECT COUNT(*) FROM cloud_common_ground_room_gallery_items WHERE account_id = $1",
        )
        .bind(account)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        count
    }
}
