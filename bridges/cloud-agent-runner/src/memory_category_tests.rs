//! Several categories per memory in cloud runs: what a `reflection` save
//! sends and how memories from older and newer servers read.

use super::*;

#[tokio::test]
async fn reflection_save_sends_categories_and_the_main_category() {
    let client = MemoryClient::new(FetchBehavior::Context(context(true, Vec::new())));
    let provider = ScriptedProvider::new(vec![ModelProviderResponse::ToolCalls(vec![
        ModelToolCall {
            id: "call_1".into(),
            name: "reflection".into(),
            arguments: json!({
                "scope": "conversation",
                "scopeId": SESSION_ID,
                "source": "user_correction",
                "lesson": "Won't work for tobacco companies.",
                "categories": ["values_and_ethics", "work_context", "values_and_ethics"]
            }),
        },
    ])]);
    run_with(&client, &provider).await;

    let saved = client.saved.lock().unwrap().clone();
    assert_eq!(saved.len(), 1);
    let body = serde_json::to_value(&saved[0].1).unwrap();
    assert_eq!(
        body["categories"],
        json!(["values_and_ethics", "work_context"])
    );
    assert_eq!(body["category"], "values_and_ethics");
}

#[tokio::test]
async fn reflection_save_without_categories_sends_neither_field() {
    let client = MemoryClient::new(FetchBehavior::Context(context(true, Vec::new())));
    let provider = ScriptedProvider::new(vec![ModelProviderResponse::ToolCalls(vec![
        ModelToolCall {
            id: "call_1".into(),
            name: "reflection".into(),
            arguments: json!({
                "scope": "conversation",
                "scopeId": SESSION_ID,
                "source": "outcome",
                "lesson": "Run the visual job serially."
            }),
        },
    ])]);
    run_with(&client, &provider).await;

    let saved = client.saved.lock().unwrap().clone();
    let body = serde_json::to_value(&saved[0].1).unwrap();
    assert!(body.get("categories").is_none(), "{body}");
    assert!(body.get("category").is_none(), "{body}");
}

#[test]
fn runner_memory_reads_categories_with_a_fallback_to_category() {
    let newer: RunnerMemory = serde_json::from_value(json!({
        "memoryId": "mem_1",
        "scope": "global",
        "scopeId": "account",
        "source": "manual",
        "text": "Won't work for tobacco companies.",
        "createdAt": "2026-10-07T09:00:00+00:00",
        "updatedAt": "2026-10-07T09:00:00+00:00",
        "category": "values_and_ethics",
        "categories": ["values_and_ethics", "work_context"],
        "sensitivity": "medium"
    }))
    .unwrap();
    assert_eq!(
        newer.memory_categories(),
        vec!["values_and_ethics", "work_context"]
    );
    assert_eq!(newer.sensitivity.as_deref(), Some("medium"));

    let older: RunnerMemory = serde_json::from_value(json!({
        "memoryId": "mem_2",
        "scope": "global",
        "scopeId": "account",
        "source": "manual",
        "text": "Works on the billing service.",
        "createdAt": "2026-10-07T09:00:00+00:00",
        "updatedAt": "2026-10-07T09:00:00+00:00",
        "category": "work_context"
    }))
    .unwrap();
    assert!(older.categories.is_empty());
    assert_eq!(older.memory_categories(), vec!["work_context"]);
}
