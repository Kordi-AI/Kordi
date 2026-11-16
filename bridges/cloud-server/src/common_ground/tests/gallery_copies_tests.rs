//! Room gallery titles and previews: copied from the document's heading and
//! text when shared, and copied again when the sharer saves or renames the
//! document.

use serde_json::{json, Value};
use sqlx_core::query::query;

use super::db_fixture::send;
use super::gallery_support::{document, setup, upload, Setup, UPDATED};

impl Setup {
    /// Saves `source` over revision `base` through the document route.
    async fn save_document(&self, token: &str, attachment_id: &str, base: i64, source: &str) {
        let path = format!("/v1/cloud/documents/{attachment_id}/content");
        let body = json!({ "baseRevision": base, "source": source });
        let (status, answer) = send(&self.app, "PUT", &path, token, Some(body)).await;
        assert_eq!(status, 200, "{answer}");
    }

    /// Renames the document through the document route.
    async fn rename_document(&self, token: &str, attachment_id: &str, title: &str) {
        let path = format!("/v1/cloud/documents/{attachment_id}");
        let body = json!({ "title": title });
        let (status, answer) = send(&self.app, "PATCH", &path, token, Some(body)).await;
        assert_eq!(status, 200, "{answer}");
    }

    /// The item as `token` reads it.
    async fn item(&self, token: &str, item: &str) -> Value {
        let (status, body) = self.read(token, item).await;
        assert_eq!(status, 200, "{body}");
        body["item"].clone()
    }
}

#[tokio::test]
async fn sharing_a_document_copies_its_heading_as_the_title() {
    let Some(s) = setup().await else {
        return;
    };
    let (alex, alex_token) = s.alex.clone();
    let source = "Draft for the lab\n\n# Field  notes\n\nBody";
    let notes = document(&s.pool, &alex, "Renamed", source).await;
    // A document whose text is not stored is read from object storage, which
    // this test server lacks: it keeps the title without its text.
    let unread = upload(&s.pool, &alex, "text/markdown").await;
    query("UPDATE cloud_attachments SET document_title = 'Unread' WHERE attachment_id = $1")
        .bind(&unread)
        .execute(&s.pool)
        .await
        .unwrap();

    let (status, body) = s.candidates(&alex_token).await;
    assert_eq!(status, 200, "{body}");
    let title = |attachment_id: &str| {
        body["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|artifact| artifact["attachmentId"] == attachment_id)
            .map(|artifact| artifact["title"].clone())
            .unwrap()
    };
    assert_eq!(title(&notes), "Field notes");
    assert_eq!(title(&unread), "Unread");

    let (status, body) = s.share(&alex_token, &[&notes, &unread], None).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["items"][0]["title"], "Field notes");
    assert_eq!(body["items"][0]["preview"], source);
    assert_eq!(body["items"][1]["title"], "Unread");
    assert_eq!(body["items"][1]["preview"], Value::Null);
}

#[tokio::test]
async fn saving_the_document_refreshes_its_items() {
    let Some(s) = setup().await else {
        return;
    };
    let (alex, alex_token) = s.alex.clone();
    let priya = s.priya.0.clone();
    let plan = document(&s.pool, &alex, "Plan", "# Plan\n\nFirst draft").await;
    let item = s.share_one(&alex_token, &plan).await;
    let before = s.hints(&priya, UPDATED).await;

    let saved = format!("# Final plan\n\n{}", "Agreed. ".repeat(120));
    s.save_document(&alex_token, &plan, 1, &saved).await;
    let seen = s.item(&s.priya.1, &item).await;
    assert_eq!(seen["title"], "Final plan");
    let preview: String = saved.chars().take(800).collect();
    assert_eq!(seen["preview"], preview.as_str());
    for account in [&alex, &priya, &s.sam.0] {
        assert_eq!(
            s.last_hint(account).await,
            json!({ "code": s.code, "itemId": item, "itemIds": [item], "change": "item" })
        );
    }
    assert_eq!(s.hints(&priya, UPDATED).await, before + 1);

    // A save past the preview changes neither copy and tells nobody.
    let tail = format!("{saved}\n\nOne more line.");
    s.save_document(&alex_token, &plan, 2, &tail).await;
    assert_eq!(s.hints(&priya, UPDATED).await, before + 1);
    assert_eq!(s.item(&s.priya.1, &item).await["preview"], preview.as_str());
}

#[tokio::test]
async fn renaming_the_document_refreshes_its_items() {
    let Some(s) = setup().await else {
        return;
    };
    let (alex, alex_token) = s.alex.clone();
    let priya = s.priya.0.clone();
    let notes = document(&s.pool, &alex, "Notes", "Plain notes without a heading").await;
    let item = s.share_one(&alex_token, &notes).await;
    let before = s.hints(&priya, UPDATED).await;

    s.rename_document(&alex_token, &notes, "Q4 plan").await;
    assert_eq!(s.item(&s.priya.1, &item).await["title"], "Q4 plan");
    assert_eq!(s.hints(&priya, UPDATED).await, before + 1);
    let hint = s.last_hint(&priya).await;
    assert_eq!(hint["change"], "item");
    assert_eq!(hint["itemIds"], json!([item]));

    // A heading stays the title, so renaming that document changes nothing.
    let plan = document(&s.pool, &alex, "Plan", "# Plan").await;
    let plan_item = s.share_one(&alex_token, &plan).await;
    let count = s.hints(&priya, UPDATED).await;
    s.rename_document(&alex_token, &plan, "Other").await;
    assert_eq!(s.item(&s.priya.1, &plan_item).await["title"], "Plan");
    assert_eq!(s.hints(&priya, UPDATED).await, count);
}
