//! Database tests for snapshots that send `baseRevision`: a save from outside
//! the collaboration room (a person's revisioned save or an agent's edit)
//! that the snapshot's base has not seen answers a conflict instead of being
//! overwritten, and `outsideRoomRevision` tells clients where the latest
//! revision came from.

use axum::http::StatusCode;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;

use super::agents_fixture::*;
use super::db_fixture::*;

const OUTSIDE: &str =
    "# Field notes\n\nFirst paragraph, saved outside the room.\n\nSecond paragraph.\n";
const ROOM: &str = "# Field notes\n\nFirst paragraph, typed in the room.\n\nSecond paragraph.\n";
const ROOM_LATER: &str =
    "# Field notes\n\nFirst paragraph, typed in the room again.\n\nSecond paragraph.\n";

/// PUTs `body` to the content route as the account behind `token`.
async fn put(f: &Fixture, token: &str, body: Value) -> (StatusCode, Value) {
    let uri = format!("/v1/cloud/documents/{}/content", f.attachment_id);
    send(&f.app, "PUT", &uri, Some(token), Some(body)).await
}

fn snapshot(source: &str, base: Option<i64>) -> Value {
    let mut body = json!({ "mode": "snapshot", "source": source });
    if let Some(base) = base {
        body["baseRevision"] = json!(base);
    }
    body
}

/// A revisioned save by the owner, which must be accepted.
async fn outside_save(f: &Fixture, base: i64, source: &str) -> Value {
    let body = json!({ "baseRevision": base, "source": source });
    let (status, saved) = put(f, &f.owner_token, body).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    saved
}

/// The stored `(source, revision, outside_room_revision)`.
async fn stored(f: &Fixture) -> (String, i64, i64) {
    query_as(
        "SELECT source, revision, outside_room_revision FROM cloud_document_contents \
         WHERE attachment_id = $1",
    )
    .bind(&f.attachment_id)
    .fetch_one(&f.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn a_snapshot_based_before_an_outside_save_conflicts_and_writes_nothing() {
    let Some(f) = fixture().await else { return };
    let fresh = document(&f, &f.owner_token).await;
    assert_eq!(fresh["revision"], 1);
    assert_eq!(fresh["outsideRoomRevision"], 0, "no outside save yet");

    let saved = outside_save(&f, 1, OUTSIDE).await;
    assert_eq!(saved["revision"], 2);
    assert_eq!(saved["outsideRoomRevision"], 2);
    assert_eq!(
        document(&f, &f.member_token).await["outsideRoomRevision"],
        2
    );

    // The room's snapshot writer still works from revision 1.
    let (status, conflict) = put(&f, &f.member_token, snapshot(ROOM, Some(1))).await;
    assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
    assert_eq!(conflict["errorCode"], "document_revision_conflict");
    assert_eq!(conflict["attachmentId"], f.attachment_id.as_str());
    assert_eq!(conflict["revision"], 2);
    assert_eq!(conflict["outsideRoomRevision"], 2);
    assert_eq!(
        conflict["blocks"][1]["source"],
        "First paragraph, saved outside the room."
    );
    assert_eq!(stored(&f).await, (OUTSIDE.to_string(), 2, 2));

    // Once the room has seen the outside save, its snapshots go through and
    // leave `outsideRoomRevision` alone.
    let (status, synced) = put(&f, &f.member_token, snapshot(ROOM, Some(2))).await;
    assert_eq!(status, StatusCode::OK, "{synced}");
    assert_eq!(synced["revision"], 3);
    assert_eq!(synced["outsideRoomRevision"], 2);
    assert_eq!(stored(&f).await, (ROOM.to_string(), 3, 2));
    let (status, ahead) = put(&f, &f.member_token, snapshot(ROOM_LATER, Some(7))).await;
    assert_eq!(status, StatusCode::OK, "{ahead}");
    assert_eq!(ahead["revision"], 4);
    assert_eq!(ahead["outsideRoomRevision"], 2);

    // Public readers do not get the field.
    let token = token_of(&create_share(&f).await);
    let uri = format!("/v1/cloud/public/documents/{token}");
    let (status, public) = send(&f.app, "GET", &uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{public}");
    assert_eq!(public["revision"], 4);
    assert!(public.get("outsideRoomRevision").is_none(), "{public}");
}

#[tokio::test]
async fn a_snapshot_without_a_base_is_not_checked() {
    let Some(f) = fixture().await else { return };
    outside_save(&f, 1, OUTSIDE).await;
    let (status, saved) = put(&f, &f.member_token, snapshot(ROOM, None)).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["revision"], 3);
    assert_eq!(saved["outsideRoomRevision"], 2);
    assert_eq!(stored(&f).await, (ROOM.to_string(), 3, 2));
}

#[tokio::test]
async fn snapshots_after_snapshots_pass_the_check() {
    let Some(f) = fixture().await else { return };
    // Snapshots alone never conflict, whatever revision they started from.
    let (status, first) = put(&f, &f.member_token, snapshot(ROOM, Some(1))).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["revision"], 2);
    assert_eq!(first["outsideRoomRevision"], 0);

    outside_save(&f, 2, OUTSIDE).await;
    let (status, synced) = put(&f, &f.owner_token, snapshot(ROOM, Some(3))).await;
    assert_eq!(status, StatusCode::OK, "{synced}");
    assert_eq!(synced["revision"], 4);
    // Another editor still on revision 3: snapshots moved the revision on,
    // but nothing was saved from outside the room since.
    let (status, later) = put(&f, &f.member_token, snapshot(ROOM_LATER, Some(3))).await;
    assert_eq!(status, StatusCode::OK, "{later}");
    assert_eq!(later["revision"], 5);
    assert_eq!(later["outsideRoomRevision"], 3);
    let (status, same) = put(&f, &f.owner_token, snapshot(ROOM_LATER, Some(3))).await;
    assert_eq!(status, StatusCode::OK, "{same}");
    assert_eq!(
        same["revision"], 5,
        "an unchanged snapshot keeps the revision"
    );
    assert_eq!(stored(&f).await, (ROOM_LATER.to_string(), 5, 3));
}

#[tokio::test]
async fn an_agent_edit_is_an_outside_save_for_snapshots() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let mention = post_comment(&f, &f.member_token, "b1", "@Kordi tighten this").await;
    let (run_id, ..) = only_run(&f, &mention).await;
    let (runner, _) = lease(&f, &state, &run_id).await;
    let args = json!({ "baseRevision": 1, "operations": [
        { "op": "replace", "blockId": "b1", "markdown": "First paragraph, by the agent." }
    ] });
    let (status, edited) = call_tool(&state, &runner, &run_id, "edit_document", args).await;
    assert_eq!(status, StatusCode::OK, "{edited:?}");
    let edited = edited.result.unwrap();
    assert_eq!(edited["applied"], true, "{edited}");
    assert_eq!(edited["revision"], 2);
    assert_eq!(document(&f, &f.owner_token).await["outsideRoomRevision"], 2);

    let (status, conflict) = put(&f, &f.owner_token, snapshot(ROOM, Some(1))).await;
    assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
    assert_eq!(conflict["errorCode"], "document_revision_conflict");
    let (source, revision, outside) = stored(&f).await;
    assert!(
        source.contains("First paragraph, by the agent."),
        "{source}"
    );
    assert_eq!((revision, outside), (2, 2));

    let (status, saved) = put(&f, &f.owner_token, snapshot(ROOM, Some(2))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["revision"], 3);
    assert_eq!(saved["outsideRoomRevision"], 2);
}
