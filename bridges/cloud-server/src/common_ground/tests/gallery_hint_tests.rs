//! Room gallery hints: one per member per request, saying whether the list
//! or only the named items changed.

use serde_json::{json, Value};

use super::db_fixture::send;
use super::gallery_support::{document, id, setup, UPDATED};

#[tokio::test]
async fn one_share_request_sends_one_hint_per_member() {
    let Some(s) = setup().await else {
        return;
    };
    let (alex, alex_token) = s.alex.clone();
    let mut docs = Vec::new();
    for name in ["One", "Two", "Three", "Four"] {
        docs.push(document(&s.pool, &alex, name, &format!("# {name}")).await);
    }
    let members = [alex.clone(), s.priya.0.clone(), s.sam.0.clone()];
    let mut before = Vec::new();
    for account in &members {
        before.push(s.hints(account, UPDATED).await);
    }

    let (status, body) = s
        .share(&alex_token, &[&docs[2], &docs[0], &docs[1]], None)
        .await;
    assert_eq!(status, 201, "{body}");
    let items: Vec<String> = body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| id(&item["itemId"]))
        .collect();
    for (account, before) in members.iter().zip(&before) {
        assert_eq!(s.hints(account, UPDATED).await, before + 1, "{account}");
        assert_eq!(
            s.last_hint(account).await,
            json!({ "code": s.code, "itemId": items[0], "itemIds": items, "change": "list" })
        );
    }

    // Only the newly shared items are named; nothing new, no hint.
    let (status, body) = s.share(&alex_token, &[&docs[0], &docs[3]], None).await;
    assert_eq!(status, 201, "{body}");
    let added = id(&body["items"][1]["itemId"]);
    assert_eq!(s.last_hint(&s.priya.0).await["itemIds"], json!([added]));
    let count = s.hints(&s.priya.0, UPDATED).await;
    assert_eq!(s.share(&alex_token, &[&docs[3]], None).await.0, 201);
    assert_eq!(s.hints(&s.priya.0, UPDATED).await, count);
}

#[tokio::test]
async fn a_leaving_member_sends_one_hint_per_remaining_member() {
    let Some(s) = setup().await else {
        return;
    };
    let (priya, priya_token) = s.priya.clone();
    let mut docs = Vec::new();
    for name in ["One", "Two", "Three"] {
        docs.push(document(&s.pool, &priya, name, &format!("# {name}")).await);
    }
    let refs: Vec<&str> = docs.iter().map(String::as_str).collect();
    let (status, body) = s.share(&priya_token, &refs, None).await;
    assert_eq!(status, 201, "{body}");
    let mut items: Vec<String> = body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| id(&item["itemId"]))
        .collect();
    items.sort();
    let others = [s.alex.0.clone(), s.sam.0.clone()];
    let mut before = Vec::new();
    for account in &others {
        before.push(s.hints(account, UPDATED).await);
    }
    let priya_before = s.hints(&priya, UPDATED).await;

    let leave = format!("/v1/cloud/common-ground/rooms/{}/leave", s.code);
    assert_eq!(
        send(&s.app, "POST", &leave, &priya_token, None).await.0,
        204
    );
    for (account, before) in others.iter().zip(&before) {
        assert_eq!(s.hints(account, UPDATED).await, before + 1, "{account}");
        let hint = s.last_hint(account).await;
        assert_eq!(hint["change"], "list");
        let mut named: Vec<String> = hint["itemIds"].as_array().unwrap().iter().map(id).collect();
        assert_eq!(hint["itemId"], Value::String(named[0].clone()));
        named.sort();
        assert_eq!(named, items);
    }
    assert_eq!(
        s.hints(&priya, UPDATED).await,
        priya_before,
        "not the leaver"
    );
}
