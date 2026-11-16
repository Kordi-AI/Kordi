//! Room gallery: sharing, listing, reading and removing items, which
//! artifacts may be shared, the per-person limit, and who sees what.

use serde_json::{json, Value};

use super::db_fixture::{send, signed_in};
use super::gallery_support::{agent_document, document, id, setup, upload, UPDATED};

#[tokio::test]
async fn share_list_read_and_remove() {
    let Some(s) = setup().await else {
        return;
    };
    let (alex, alex_token) = s.alex.clone();
    let (priya, priya_token) = s.priya.clone();
    let source = format!("# Plan\n\n{}", "Agent memory. ".repeat(100));
    let plan = document(&s.pool, &alex, "Research plan", &source).await;
    let room_hints = s.hints(&priya, "common_ground.room.updated").await;

    let (status, body) = s.share(&alex_token, &[&plan], Some("  Memory  ")).await;
    assert_eq!(status, 201, "{body}");
    let item = body["items"][0].clone();
    let item_id = id(&item["itemId"]);
    assert_eq!(item["attachmentId"], plan.as_str());
    assert_eq!(item["title"], "Research plan");
    assert_eq!(item["fileName"], "Untitled");
    assert_eq!(item["contentType"], "text/markdown");
    assert_eq!(item["sizeBytes"], source.len());
    assert_eq!(item["topic"], "Memory");
    let preview: String = source.chars().take(800).collect();
    assert_eq!(item["preview"], preview.as_str());
    assert_eq!(item["person"]["accountId"], alex.as_str());
    assert_eq!(item["mine"], true);
    assert_eq!(item["commentCount"], 0);
    assert!(item["createdAt"].is_string());

    // Every member is told, Alex too; the room itself did not change.
    for account in [&alex, &priya, &s.sam.0] {
        assert_eq!(s.hints(account, UPDATED).await, 1);
    }
    assert_eq!(
        s.last_hint(&priya).await,
        json!({ "code": s.code, "itemId": item_id })
    );
    assert_eq!(
        s.hints(&priya, "common_ground.room.updated").await,
        room_hints
    );

    let (status, list) = s.list(&priya_token).await;
    assert_eq!(status, 200, "{list}");
    assert_eq!(list["canShare"], true);
    let seen = &list["items"][0];
    assert_eq!(seen["itemId"], item_id.as_str());
    assert_eq!(seen["mine"], false);
    // The person is the one the room's members list uses.
    let person = &seen["person"];
    assert_eq!(person["name"], "Alex");
    assert_eq!(person["hasCard"], true);
    assert!(person["profile"]["profileId"].is_string());
    assert_eq!(person["relationship"]["contact"], false);

    let (status, read) = s.read(&priya_token, &item_id).await;
    assert_eq!(status, 200, "{read}");
    assert_eq!(read["item"]["itemId"], item_id.as_str());
    assert_eq!(read["comments"], json!([]));

    // Sharing it again returns the item as it was.
    let (status, again) = s.share(&alex_token, &[&plan], Some("Other")).await;
    assert_eq!(status, 201, "{again}");
    assert_eq!(again["items"][0]["itemId"], item_id.as_str());
    assert_eq!(again["items"][0]["topic"], "Memory");
    assert_eq!(s.hints(&priya, UPDATED).await, 1);

    let (status, body) = s.remove(&priya_token, &item_id).await;
    assert_eq!(status, 404, "only the sharer removes: {body}");
    assert_eq!(body["errorCode"], "common_ground_gallery_item_not_found");
    let (status, _) = s.remove(&alex_token, &item_id).await;
    assert_eq!(status, 204);
    assert_eq!(s.hints(&priya, UPDATED).await, 2);
    assert!(s.item_ids(&priya_token).await.is_empty());
    assert_eq!(s.read(&priya_token, &item_id).await.0, 404);
    assert_eq!(s.read(&priya_token, "not-an-id").await.0, 404);
}

#[tokio::test]
async fn content_is_never_rendered_as_a_page() {
    let Some(s) = setup().await else {
        return;
    };
    let plan = document(&s.pool, &s.alex.0, "Plan", "# Plan").await;
    let item = s.share_one(&s.alex.1, &plan).await;
    let (status, headers) = s.content_headers(&s.priya.1, &item).await;
    assert_eq!(status, 200);
    assert_eq!(headers["content-type"], "text/markdown; charset=utf-8");
    assert_eq!(
        headers["content-security-policy"],
        "sandbox; default-src 'none'"
    );
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(headers["content-disposition"], "attachment");
}

#[tokio::test]
async fn only_your_own_artifacts_can_be_shared() {
    let Some(s) = setup().await else {
        return;
    };
    let (alex, alex_token) = s.alex.clone();
    let priya = s.priya.0.clone();
    let mine = document(&s.pool, &alex, "Mine", "# Mine").await;
    let theirs = document(&s.pool, &priya, "Theirs", "# Theirs").await;
    let forwarded = document(&s.pool, &alex, "Forwarded", "# Copy").await;
    sqlx_core::query::query(
        "UPDATE cloud_attachments SET document_source_attachment_id = $2 WHERE attachment_id = $1",
    )
    .bind(&forwarded)
    .bind(&theirs)
    .execute(&s.pool)
    .await
    .unwrap();
    // A photo sent in a chat is an upload, not an artifact.
    let photo = upload(&s.pool, &alex, "image/png").await;
    // Agent documents count whatever their type, unless someone else asked.
    let report = upload(&s.pool, &alex, "application/pdf").await;
    agent_document(&s.pool, &report, &alex, &alex, "report.pdf").await;
    let asked = upload(&s.pool, &alex, "application/pdf").await;
    agent_document(&s.pool, &asked, &alex, &priya, "asked.pdf").await;
    let unfinished = document(&s.pool, &alex, "Draft", "# Draft").await;
    sqlx_core::query::query(
        "UPDATE cloud_attachments SET finalized_at = NULL WHERE attachment_id = $1",
    )
    .bind(&unfinished)
    .execute(&s.pool)
    .await
    .unwrap();

    for refused in [&theirs, &forwarded, &photo, &asked, &unfinished] {
        let (status, body) = s.share(&alex_token, &[&mine, refused], None).await;
        assert_eq!(status, 400, "{refused}: {body}");
        assert_eq!(body["errorCode"], "common_ground_gallery_not_shareable");
    }
    assert!(
        s.item_ids(&alex_token).await.is_empty(),
        "nothing is shared"
    );

    let (status, body) = s.share(&alex_token, &[&report], None).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["items"][0]["title"], "Agent report");
    assert_eq!(body["items"][0]["fileName"], "report.pdf");
    assert_eq!(body["items"][0]["contentType"], "application/pdf");
    assert_eq!(body["items"][0]["preview"], Value::Null);

    let (status, body) = s.candidates(&alex_token).await;
    assert_eq!(status, 200, "{body}");
    let listed: Vec<(String, bool)> = body["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| (id(&a["attachmentId"]), a["shared"].as_bool().unwrap()))
        .collect();
    assert_eq!(listed.len(), 2, "{body}");
    assert!(listed.contains(&(report.clone(), true)));
    assert!(listed.contains(&(mine.clone(), false)));
    let report_entry = body["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["attachmentId"] == report.as_str())
        .unwrap();
    assert_eq!(report_entry["fileName"], "report.pdf");
    assert_eq!(report_entry["sizeBytes"], 2048);
    assert!(report_entry["updatedAt"].is_string());

    let nine: Vec<String> = (0..9).map(|i| format!("att_{i}")).collect();
    let nine: Vec<&str> = nine.iter().map(String::as_str).collect();
    let long_topic = "t".repeat(81);
    for (ids, topic) in [
        (vec![], None),
        (nine, None),
        (vec![""], None),
        (vec![mine.as_str()], Some(long_topic.as_str())),
    ] {
        let (status, body) = s.share(&alex_token, &ids, topic).await;
        assert_eq!(status, 400, "{body}");
        assert_eq!(body["errorCode"], "common_ground_invalid_gallery");
    }
    let (status, body) = s.share(&alex_token, &[&mine], Some("   ")).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(
        body["items"][0]["topic"],
        Value::Null,
        "a blank topic is none"
    );
}

#[tokio::test]
async fn one_person_shares_at_most_twenty_items_in_a_room() {
    let Some(s) = setup().await else {
        return;
    };
    let (alex, alex_token) = s.alex.clone();
    let mut ids = Vec::new();
    for i in 0..21 {
        ids.push(document(&s.pool, &alex, &format!("Doc {i}"), &format!("# Doc {i}")).await);
    }
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    for batch in [&refs[0..8], &refs[8..16], &refs[16..20]] {
        let (status, body) = s.share(&alex_token, batch, None).await;
        assert_eq!(status, 201, "{body}");
        assert_eq!(body["items"].as_array().unwrap().len(), batch.len());
        let order: Vec<String> = body["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| id(&item["attachmentId"]))
            .collect();
        assert_eq!(order, batch.to_vec(), "items come back in the order asked");
    }
    let (status, list) = s.list(&alex_token).await;
    assert_eq!(status, 200);
    assert_eq!(list["items"].as_array().unwrap().len(), 20);
    assert_eq!(list["canShare"], false);

    let (status, body) = s.share(&alex_token, &[refs[20]], None).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["errorCode"], "common_ground_gallery_limit");
    // Asking for ones already shared is still fine.
    let (status, body) = s.share(&alex_token, &[refs[3]], None).await;
    assert_eq!(status, 201, "{body}");
    // Others have their own budget.
    let theirs = document(&s.pool, &s.priya.0, "Priya's", "# Notes").await;
    assert_eq!(s.share(&s.priya.1, &[&theirs], None).await.0, 201);
}

#[tokio::test]
async fn non_members_get_the_room_404_on_every_route() {
    let Some(s) = setup().await else {
        return;
    };
    let plan = document(&s.pool, &s.alex.0, "Plan", "# Plan").await;
    let item = s.share_one(&s.alex.1, &plan).await;
    let (outsider, token) = signed_in(&s.pool, "Outsider").await;
    let mine = document(&s.pool, &outsider, "Outside", "# Outside").await;
    let item_path = s.path(&format!("/{item}"));
    let checks: Vec<(&str, String, Option<Value>)> = vec![
        ("GET", s.path(""), None),
        ("GET", s.path("/candidates"), None),
        ("POST", s.path(""), Some(json!({ "attachmentIds": [mine] }))),
        ("GET", item_path.clone(), None),
        ("DELETE", item_path.clone(), None),
        ("GET", format!("{item_path}/content"), None),
        (
            "POST",
            format!("{item_path}/comments"),
            Some(json!({ "body": "Hi" })),
        ),
    ];
    for (method, path, body) in checks {
        let (status, answer) = send(&s.app, method, &path, &token, body).await;
        assert_eq!(status, 404, "{method} {path}: {answer}");
        assert_eq!(answer["errorCode"], "common_ground_room_not_found");
    }
    // The attachment and document routes still serve only the owner.
    let (status, _) = send(
        &s.app,
        "GET",
        &format!("/v1/cloud/documents/{plan}"),
        &s.priya.1,
        None,
    )
    .await;
    assert_eq!(status, 404, "a gallery item opens nothing elsewhere");
}

#[tokio::test]
async fn leaving_removes_your_items_and_hides_your_comments() {
    let Some(s) = setup().await else {
        return;
    };
    let (alex, alex_token) = s.alex.clone();
    let (priya, priya_token) = s.priya.clone();
    let hers = document(&s.pool, &priya, "Hers", "# Hers").await;
    let her_item = s.share_one(&priya_token, &hers).await;
    let plan = document(&s.pool, &alex, "Plan", "# Plan").await;
    let item = s.share_one(&alex_token, &plan).await;
    assert_eq!(s.comment(&priya_token, &item, "Nice").await.0, 201);
    let before = s.hints(&alex, UPDATED).await;

    let leave = format!("/v1/cloud/common-ground/rooms/{}/leave", s.code);
    assert_eq!(
        send(&s.app, "POST", &leave, &priya_token, None).await.0,
        204
    );
    assert_eq!(s.stored_items(&priya).await, 0);
    assert_eq!(s.item_ids(&alex_token).await, vec![item.clone()]);
    assert_eq!(s.hints(&alex, UPDATED).await, before + 1);
    assert_eq!(
        s.last_hint(&alex).await,
        json!({ "code": s.code, "itemId": her_item })
    );
    let (_, read) = s.read(&alex_token, &item).await;
    assert_eq!(
        read["comments"],
        json!([]),
        "a leaver's comments are not listed"
    );
    assert_eq!(read["item"]["commentCount"], 0);
    let (status, body) = s.list(&priya_token).await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(body["errorCode"], "common_ground_room_not_found");

    // Deleting the card leaves its rooms, items included.
    let sams = document(&s.pool, &s.sam.0, "Sam's", "# Sam").await;
    s.share_one(&s.sam.1, &sams).await;
    let (status, _) = send(
        &s.app,
        "DELETE",
        "/v1/cloud/common-ground/card",
        &s.sam.1,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(s.stored_items(&s.sam.0).await, 0);
    assert_eq!(s.item_ids(&alex_token).await, vec![item]);
}

#[tokio::test]
async fn a_block_either_way_hides_items_and_comments() {
    let Some(s) = setup().await else {
        return;
    };
    let (alex, alex_token) = s.alex.clone();
    let (priya, priya_token) = s.priya.clone();
    let (sam, sam_token) = s.sam.clone();
    let plan = document(&s.pool, &alex, "Plan", "# Plan").await;
    let item = s.share_one(&alex_token, &plan).await;
    assert_eq!(s.comment(&priya_token, &item, "From Priya").await.0, 201);
    assert_eq!(s.comment(&sam_token, &item, "From Sam").await.0, 201);

    // Sam blocks Priya: each stops seeing the other's comments.
    s.block(&sam, &priya).await;
    let (_, read) = s.read(&sam_token, &item).await;
    let bodies: Vec<&str> = read["comments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["body"].as_str().unwrap())
        .collect();
    assert_eq!(bodies, ["From Sam"]);
    assert_eq!(read["item"]["commentCount"], 1);
    let (_, read) = s.read(&priya_token, &item).await;
    assert_eq!(read["comments"].as_array().unwrap().len(), 1);
    let (_, read) = s.read(&alex_token, &item).await;
    assert_eq!(read["comments"].as_array().unwrap().len(), 2);

    // Alex blocks Priya: she no longer sees his item, and he not her comment.
    s.block(&alex, &priya).await;
    assert!(s.item_ids(&priya_token).await.is_empty());
    for (status, _) in [
        s.read(&priya_token, &item).await,
        s.comment(&priya_token, &item, "Still here").await,
    ] {
        assert_eq!(status, 404);
    }
    assert_eq!(s.content(&priya_token, &item).await.0, 404);
    let (_, read) = s.read(&alex_token, &item).await;
    assert_eq!(read["item"]["commentCount"], 1);
    assert_eq!(read["comments"][0]["body"], "From Sam");
    assert_eq!(s.item_ids(&sam_token).await, vec![item]);
}
