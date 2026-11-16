//! Room gallery comments, the content route, and what a closed room still
//! allows.

use serde_json::{json, Value};
use sqlx_core::query::query;

use super::gallery_support::{document, id, setup, upload, UPDATED};

#[tokio::test]
async fn comments_are_added_and_deleted_by_the_right_people() {
    let Some(s) = setup().await else {
        return;
    };
    let (alex, alex_token) = s.alex.clone();
    let (priya, priya_token) = s.priya.clone();
    let sam_token = s.sam.1.clone();
    let plan = document(&s.pool, &alex, "Plan", "# Plan").await;
    let item = s.share_one(&alex_token, &plan).await;
    let before = s.hints(&s.sam.0, UPDATED).await;

    let (status, body) = s.comment(&priya_token, &item, "  Love this  ").await;
    assert_eq!(status, 201, "{body}");
    let comment = body["comment"].clone();
    let priyas = id(&comment["commentId"]);
    assert_eq!(comment["body"], "Love this");
    assert_eq!(comment["mine"], true);
    assert_eq!(comment["person"]["accountId"], priya.as_str());
    assert!(comment["person"]["relationship"].is_object());
    assert!(comment["createdAt"].is_string());
    assert_eq!(s.hints(&s.sam.0, UPDATED).await, before + 1);
    assert_eq!(
        s.last_hint(&s.sam.0).await,
        json!({ "code": s.code, "itemId": item, "itemIds": [item], "change": "item" })
    );

    let (status, body) = s.comment(&sam_token, &item, "Same").await;
    assert_eq!(status, 201, "{body}");
    let sams = id(&body["comment"]["commentId"]);
    let (_, read) = s.read(&alex_token, &item).await;
    let comments = read["comments"].as_array().unwrap();
    assert_eq!(read["item"]["commentCount"], 2);
    assert_eq!(comments[0]["commentId"], priyas.as_str(), "oldest first");
    assert_eq!(comments[0]["mine"], false);
    assert_eq!(comments[1]["commentId"], sams.as_str());

    for text in [String::new(), "   ".to_string(), "x".repeat(2001)] {
        let (status, body) = s.comment(&priya_token, &item, &text).await;
        assert_eq!(status, 400, "{body}");
        assert_eq!(body["errorCode"], "common_ground_invalid_gallery_comment");
    }
    assert_eq!(
        s.comment(&priya_token, &item, &"x".repeat(2000)).await.0,
        201
    );

    // Sam is neither the author nor the sharer.
    let (status, body) = s.delete_comment(&sam_token, &item, &priyas).await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(body["errorCode"], "common_ground_gallery_comment_not_found");
    // The author deletes their own; the sharer deletes anyone's.
    let before = s.hints(&s.sam.0, UPDATED).await;
    assert_eq!(s.delete_comment(&priya_token, &item, &priyas).await.0, 204);
    assert_eq!(s.hints(&s.sam.0, UPDATED).await, before + 1);
    assert_eq!(s.last_hint(&s.sam.0).await["change"], "item");
    assert_eq!(s.last_hint(&s.sam.0).await["itemIds"], json!([item]));
    assert_eq!(s.delete_comment(&alex_token, &item, &sams).await.0, 204);
    assert_eq!(s.delete_comment(&alex_token, &item, &sams).await.0, 404);
    let (_, read) = s.read(&priya_token, &item).await;
    assert_eq!(read["item"]["commentCount"], 1);

    // Removing the item takes its comments along.
    assert_eq!(s.remove(&alex_token, &item).await.0, 204);
    assert_eq!(s.comment(&priya_token, &item, "Late").await.0, 404);
}

#[tokio::test]
async fn a_closed_room_keeps_its_gallery_readable() {
    let Some(s) = setup().await else {
        return;
    };
    let (alex, alex_token) = s.alex.clone();
    let priya_token = s.priya.1.clone();
    let plan = document(&s.pool, &alex, "Plan", "# Plan\n\nText").await;
    let other = document(&s.pool, &alex, "Other", "# Other").await;
    let item = s.share_one(&alex_token, &plan).await;
    let (status, body) = s.comment(&priya_token, &item, "Before closing").await;
    assert_eq!(status, 201, "{body}");
    let comment = id(&body["comment"]["commentId"]);
    s.close().await;

    let (status, list) = s.list(&priya_token).await;
    assert_eq!(status, 200, "{list}");
    assert_eq!(list["items"][0]["itemId"], item.as_str());
    assert_eq!(list["canShare"], false);
    assert_eq!(s.candidates(&alex_token).await.0, 200);
    assert_eq!(s.read(&priya_token, &item).await.0, 200);
    assert_eq!(s.content(&priya_token, &item).await.0, 200);
    for (status, body) in [
        s.share(&alex_token, &[&other], None).await,
        s.comment(&priya_token, &item, "After closing").await,
    ] {
        assert_eq!(status, 409, "{body}");
        assert_eq!(body["errorCode"], "common_ground_room_closed");
        assert_eq!(body["message"], "This room has closed.");
    }
    assert_eq!(s.delete_comment(&priya_token, &item, &comment).await.0, 204);
    assert_eq!(s.remove(&alex_token, &item).await.0, 204);
    assert!(s.item_ids(&priya_token).await.is_empty());
}

#[tokio::test]
async fn content_serves_the_current_text_to_members_only() {
    let Some(s) = setup().await else {
        return;
    };
    let (alex, alex_token) = s.alex.clone();
    let priya_token = s.priya.1.clone();
    let plan = document(&s.pool, &alex, "Plan", "# Plan\n\nFirst").await;
    let item = s.share_one(&alex_token, &plan).await;
    query("UPDATE cloud_document_contents SET source = $2, revision = 2 WHERE attachment_id = $1")
        .bind(&plan)
        .bind("# Plan\n\nEdited")
        .execute(&s.pool)
        .await
        .unwrap();
    let (status, text, content_type) = s.content(&priya_token, &item).await;
    assert_eq!(status, 200, "{text}");
    assert_eq!(text, "# Plan\n\nEdited");
    assert_eq!(
        content_type.as_deref(),
        Some("text/markdown; charset=utf-8")
    );
    // A write outside the document save path leaves the copied preview.
    let (_, read) = s.read(&priya_token, &item).await;
    assert_eq!(read["item"]["preview"], "# Plan\n\nFirst");

    // Other files stream from object storage, which this test server lacks.
    let report = upload(&s.pool, &alex, "application/pdf").await;
    super::gallery_support::agent_document(&s.pool, &report, &alex, &alex, "report.pdf").await;
    let report_item = s.share_one(&alex_token, &report).await;
    let (status, body, _) = s.content(&priya_token, &report_item).await;
    assert_eq!(status, 503, "{body}");
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["errorCode"], "attachments_unavailable");

    let (status, _, _) = s
        .content(&priya_token, "00000000-0000-0000-0000-000000000000")
        .await;
    assert_eq!(status, 404);
    let leave = format!("/v1/cloud/common-ground/rooms/{}/leave", s.code);
    let (status, _) = super::db_fixture::send(&s.app, "POST", &leave, &priya_token, None).await;
    assert_eq!(status, 204);
    let (status, body, _) = s.content(&priya_token, &item).await;
    assert_eq!(status, 404, "{body}");
}

#[tokio::test]
async fn an_item_lists_its_newest_comments_oldest_first() {
    let Some(s) = setup().await else {
        return;
    };
    let plan = document(&s.pool, &s.alex.0, "Plan", "# Plan").await;
    let item = s.share_one(&s.alex.1, &plan).await;
    query(
        "INSERT INTO cloud_common_ground_room_gallery_comments
             (comment_id, item_id, account_id, body, created_at)
         SELECT gen_random_uuid(), $1, $2, 'Comment ' || n,
                now() - make_interval(mins => 205 - n)
         FROM generate_series(0, 204) n",
    )
    .bind(item.parse::<uuid::Uuid>().unwrap())
    .bind(&s.priya.0)
    .execute(&s.pool)
    .await
    .unwrap();

    let (status, read) = s.read(&s.sam.1, &item).await;
    assert_eq!(status, 200, "{read}");
    let bodies: Vec<&str> = read["comments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|comment| comment["body"].as_str().unwrap())
        .collect();
    assert_eq!(bodies.len(), 200);
    assert_eq!(bodies[0], "Comment 5");
    assert_eq!(bodies[199], "Comment 204");
    assert_eq!(read["item"]["commentCount"], 200);
    let (_, list) = s.list(&s.sam.1).await;
    assert_eq!(list["items"][0]["commentCount"], 200);
}
