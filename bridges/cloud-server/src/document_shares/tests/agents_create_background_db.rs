//! Database tests for `create_document` in a background session of a group
//! request: a follow-up someone asks inside the background session on the
//! owner's Mac, and a cloud child of a group run. The run's lease carries
//! `create_document`, the document is posted in the parent group as the
//! agent's own message at once (the background session's reply never reaches
//! the group), and it is listed in the group's Artifacts. Reads follow the
//! owner's own request; edits never; a parent that is no group gets nothing.

use axum::http::StatusCode;
use chrono::Utc;
use serde_json::json;
use sqlx_core::query::query;
use uuid::Uuid;

use super::agents_create_fixture::*;
use super::agents_fixture::*;
use super::db_fixture::*;
use crate::connectors::delivery::deliver_to_run;

/// A background session of the owner's agent under `parent_session_id`.
async fn background_session(f: &Fixture, conversation: Uuid, parent_session_id: &str) -> Uuid {
    let id = Uuid::new_v4();
    query(
        "INSERT INTO cloud_agent_subsessions (subsession_id, parent_conversation_id, \
         parent_session_id, parent_request_id, owner_account_id, publisher_device_id, \
         execution_backend, agent_id, title, status) \
         VALUES ($1, $2, $3, 'msg_parent', $4, 'device_owner', 'desktop', $5, \
                 'Literature review', 'running')",
    )
    .bind(id)
    .bind(conversation)
    .bind(parent_session_id)
    .bind(&f.owner)
    .bind(format!("cloud-agent:{}", f.owner))
    .execute(&f.pool)
    .await
    .unwrap();
    id
}

/// A follow-up `requester` asked inside the background session, held by the
/// owner's Mac under `executor`. Its tools are not delivered yet.
async fn follow_up_run(
    f: &Fixture,
    session_id: &str,
    subsession: Uuid,
    requester: &str,
    executor: &str,
) -> String {
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let now = Utc::now();
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
         session_id, owner_account_id, requester_account_id, status, prompt, created_at, \
         updated_at, run_trigger, execution_backend, execution_agent_id, claimed_by, \
         lease_expires_at, subsession_id) \
         VALUES ($1, $1, $2, $3, $4, $5, 'running', 'continue', $6, $6, 'person_started', \
                 'desktop', $7, $8, $9, $10)",
    )
    .bind(&run_id)
    .bind(Uuid::new_v4().to_string())
    .bind(session_id)
    .bind(&f.owner)
    .bind(requester)
    .bind(now.to_rfc3339())
    .bind(format!("cloud-agent:{}", f.owner))
    .bind(executor)
    .bind((now + chrono::Duration::minutes(5)).to_rfc3339())
    .bind(subsession)
    .execute(&f.pool)
    .await
    .unwrap();
    run_id
}

/// A cloud child of the group run `parent`, queued for the runner.
async fn cloud_child_run(f: &Fixture, session_id: &str, subsession: Uuid, parent: &str) -> String {
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
         session_id, owner_account_id, requester_account_id, status, prompt, created_at, \
         updated_at, run_trigger, execution_backend, execution_agent_id, parent_run_id, \
         subsession_id) \
         VALUES ($1, $1, $2, $3, $4, $5, 'queued', 'Write the review', $6, $6, 'background', \
                 'cloud', $7, $8, $9)",
    )
    .bind(&run_id)
    .bind(format!("subsession:{subsession}"))
    .bind(session_id)
    .bind(&f.owner)
    .bind(&f.member)
    .bind(now)
    .bind(format!("cloud-agent:{}", f.owner))
    .bind(parent)
    .bind(subsession)
    .execute(&f.pool)
    .await
    .unwrap();
    run_id
}

async fn delivered_names(f: &Fixture, run_id: &str) -> Vec<String> {
    let state = state(f).await;
    deliver_to_run(&f.pool, &state.connectors().providers, run_id)
        .await
        .into_iter()
        .map(|tool| tool.name)
        .collect()
}

async fn assert_in_artifacts(f: &Fixture, session_id: &str, attachment_id: &str) {
    let uri = format!("/v1/cloud/session-activity?sessionId={session_id}");
    let (_, activity) = send(&f.app, "GET", &uri, Some(&f.member_token), None).await;
    assert!(
        activity["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|artifact| artifact["attachmentId"] == attachment_id),
        "{activity}"
    );
}

/// The reported case: the owner asks a background session of a group
/// request to continue, and its run saves the review in the group.
#[tokio::test]
async fn a_background_follow_up_posts_its_document_in_the_parent_group() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let (conversation, session_id) = group(&f).await;
    send_request(&f, conversation, &session_id).await;
    let subsession = background_session(&f, conversation, &session_id).await;
    let executor = format!("desktop:{}", Uuid::new_v4());
    let run_id = follow_up_run(&f, &session_id, subsession, &f.owner, &executor).await;
    assert_eq!(
        delivered_names(&f, &run_id).await,
        ["read_document", "create_document"]
    );

    let (status, created) = desktop_call(
        &f,
        &state,
        &executor,
        &run_id,
        "create_document",
        plan_args(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created:?}");
    let attachment_id = attachment_of(&created);
    let note = created.result.as_ref().unwrap()["note"].as_str().unwrap();
    assert!(note.contains("posted in the group"), "{note}");

    // Posted at once as the agent's own document card, while the run is
    // still running: no group reply will carry it.
    let envelope = assert_carried_by_agent(&f, &attachment_id).await;
    assert_eq!(envelope["groupId"], session_id.as_str());
    assert!(envelope["message"]["requestId"].is_null(), "{envelope}");
    assert_in_artifacts(&f, &session_id, &attachment_id).await;
    let uri = format!("/v1/cloud/documents/{attachment_id}");
    let (status, document) = send(&f.app, "GET", &uri, Some(&f.member_token), None).await;
    assert_eq!(status, StatusCode::OK, "{document}");
    let (status, _) = send(&f.app, "GET", &uri, Some(&f.outsider_token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A retry finds the first document and its one message.
    let (_, again) = desktop_call(
        &f,
        &state,
        &executor,
        &run_id,
        "create_document",
        plan_args(),
    )
    .await;
    assert_eq!(attachment_of(&again), attachment_id);
    assert_eq!(messages_with(&f, &attachment_id).await.len(), 1);

    // The owner's own follow-up reads the group's documents, never edits.
    let read = json!({ "attachmentId": f.attachment_id });
    let (status, _) = desktop_call(&f, &state, &executor, &run_id, "read_document", read).await;
    assert_eq!(status, StatusCode::OK);
    let edit = json!({ "attachmentId": f.attachment_id, "baseRevision": 1,
                       "operations": [{ "op": "delete", "blockId": "b1" }] });
    let (status, refused) =
        desktop_call(&f, &state, &executor, &run_id, "edit_document", edit).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused:?}");
}

/// Another member's follow-up creates in the group but reads nothing.
#[tokio::test]
async fn a_members_background_follow_up_creates_without_reading() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let (conversation, session_id) = group(&f).await;
    send_request(&f, conversation, &session_id).await;
    let subsession = background_session(&f, conversation, &session_id).await;
    let executor = format!("desktop:{}", Uuid::new_v4());
    let run_id = follow_up_run(&f, &session_id, subsession, &f.member, &executor).await;
    assert_eq!(delivered_names(&f, &run_id).await, ["create_document"]);
    let read = json!({ "attachmentId": f.attachment_id });
    let (status, _) = desktop_call(&f, &state, &executor, &run_id, "read_document", read).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, created) = desktop_call(
        &f,
        &state,
        &executor,
        &run_id,
        "create_document",
        plan_args(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created:?}");
    assert_carried_by_agent(&f, &attachment_of(&created)).await;
}

/// A cloud child of a group run gets `create_document` on the runner's lease
/// and its document reaches the group the same way.
#[tokio::test]
async fn a_cloud_child_of_a_group_run_posts_its_document_in_the_group() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let (conversation, session_id) = group(&f).await;
    let request_id = send_request(&f, conversation, &session_id).await;
    let parent = chat_run(&f, &session_id, &f.member, &request_id).await;
    let subsession = background_session(&f, conversation, &session_id).await;
    let child = cloud_child_run(&f, &session_id, subsession, &parent).await;
    let (runner, tools) = lease(&f, &state, &child).await;
    // Another member asked: no reads, no edits.
    assert_eq!(tool_names(&tools), ["create_document"]);
    assert!(tools[0].description.contains("posted in the group"));
    let (status, created) =
        call_tool(&state, &runner, &child, "create_document", plan_args()).await;
    assert_eq!(status, StatusCode::OK, "{created:?}");
    let attachment_id = attachment_of(&created);
    assert_carried_by_agent(&f, &attachment_id).await;
    assert_in_artifacts(&f, &session_id, &attachment_id).await;
}

/// No document tool for a background session whose parent is no group, nor
/// for a child run whose background session belongs to another session.
#[tokio::test]
async fn a_background_session_outside_a_group_gets_no_document_tools() {
    let Some(f) = fixture().await else { return };
    let (conversation, session_id) = group(&f).await;
    let executor = format!("desktop:{}", Uuid::new_v4());

    let direct = format!("session:direct-person:{}:{}", f.member, f.owner);
    let subsession = background_session(&f, conversation, &direct).await;
    let run_id = follow_up_run(&f, &direct, subsession, &f.owner, &executor).await;
    assert!(delivered_names(&f, &run_id).await.is_empty());

    // The run claims the group, but its background session is elsewhere.
    let run_id = follow_up_run(&f, &session_id, subsession, &f.owner, &executor).await;
    assert!(delivered_names(&f, &run_id).await.is_empty());
}
