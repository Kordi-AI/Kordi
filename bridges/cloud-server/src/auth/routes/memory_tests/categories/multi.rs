use super::*;

/// `(category, categories, sensitivity)` of a memory response.
fn kinds(memory: &Value) -> (Value, Value, Value) {
    (
        memory["category"].clone(),
        memory["categories"].clone(),
        memory["sensitivity"].clone(),
    )
}

/// The stored `(category, categories)` of a memory.
async fn stored(fx: &Fixture, memory_id: &str) -> (String, Vec<String>) {
    query_as("SELECT category, categories FROM cloud_account_memories WHERE memory_id = $1")
        .bind(memory_id)
        .fetch_one(&fx.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn save_and_edit_several_categories() {
    let Some(fx) = fixture().await else { return };

    // Order kept, repeats dropped, `categories` wins over `category`.
    let (status, saved) = save(
        &fx,
        with(
            "Leads the Atlas study at the clinic",
            json!({
                "category": "general_preferences",
                "categories": ["work_context", " health_context ", "work_context"],
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{saved}");
    let memory = &saved["memory"];
    assert_eq!(
        kinds(memory),
        (
            json!("work_context"),
            json!(["work_context", "health_context"]),
            json!("high")
        )
    );
    assert_eq!(memory["profileKind"], "work", "the primary decides");
    let id = memory["memoryId"].as_str().unwrap().to_string();
    assert_eq!(
        stored(&fx, &id).await,
        (
            "work_context".to_string(),
            vec!["work_context".to_string(), "health_context".to_string()]
        )
    );
    let (_, list) = fx.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(list["memories"][0], *memory);
    assert_eq!(
        fx.audit_metadata("memory_saved").await[0]["categories"],
        json!(["work_context", "health_context"])
    );

    // A legacy save gets one category; no category at all is the default.
    let (_, legacy) = save(
        &fx,
        with(
            "Free on Tuesdays",
            json!({ "category": "coordination_context" }),
        ),
    )
    .await;
    assert_eq!(
        kinds(&legacy["memory"]),
        (
            json!("coordination_context"),
            json!(["coordination_context"]),
            json!("medium")
        )
    );
    let (_, plain) = save(&fx, memory_body("Prefers short replies")).await;
    assert_eq!(
        kinds(&plain["memory"]),
        (
            json!("general_preferences"),
            json!(["general_preferences"]),
            json!("low")
        )
    );

    // The same text again returns the memory without adding categories.
    let (status, again) = save(
        &fx,
        with(
            "Leads the Atlas study at the clinic",
            json!({ "categories": ["location_context", "goals_and_constraints"] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["memory"]["memoryId"], id.as_str());
    assert_eq!(
        again["memory"]["categories"],
        json!(["work_context", "health_context"])
    );

    // The legacy category replaces only the primary and keeps the others.
    let (status, edited) = patch(&fx, &id, json!({ "category": "location_context" })).await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(
        kinds(&edited["memory"]),
        (
            json!("location_context"),
            json!(["location_context", "health_context"]),
            json!("high")
        )
    );
    assert_eq!(edited["memory"]["profileKind"], "daily");
    // A legacy category already among the others moves to the front once.
    let (_, edited) = patch(&fx, &id, json!({ "category": "health_context" })).await;
    assert_eq!(edited["memory"]["categories"], json!(["health_context"]));
    let (_, edited) = patch(
        &fx,
        &id,
        json!({ "categories": ["work_context", "health_context", "location_context"] }),
    )
    .await;
    assert_eq!(
        edited["memory"]["categories"],
        json!(["work_context", "health_context", "location_context"])
    );

    // `categories` replaces the whole set and wins over `category`.
    let (status, edited) = patch(
        &fx,
        &id,
        json!({ "categories": ["goals_and_constraints"], "category": "health_context" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        kinds(&edited["memory"]),
        (
            json!("goals_and_constraints"),
            json!(["goals_and_constraints"]),
            json!("low")
        )
    );
    assert_eq!(
        fx.audit_metadata("memory_updated").await.last().unwrap()["categories"],
        json!(["goals_and_constraints"])
    );
    assert_eq!(
        stored(&fx, &id).await,
        (
            "goals_and_constraints".to_string(),
            vec!["goals_and_constraints".to_string()]
        )
    );

    // One to three known categories.
    for categories in [
        json!([]),
        json!(["diary"]),
        json!(["work_context", ""]),
        json!([
            "work_context",
            "health_context",
            "location_context",
            "general_preferences"
        ]),
    ] {
        let (status, error) = save(
            &fx,
            with("Refused", json!({ "categories": categories.clone() })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{categories}");
        assert_eq!(error["errorCode"], "invalid_category");
        let (status, error) = patch(&fx, &id, json!({ "categories": categories.clone() })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{categories}");
        assert_eq!(error["errorCode"], "invalid_category");
    }
    let (status, error) = patch(&fx, &id, json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        error["message"].as_str().unwrap().contains("categories"),
        "{error}"
    );
    fx.cleanup().await;
}

#[tokio::test]
async fn group_memories_need_every_category_shared() {
    let Some(g) = group().await else { return };

    let mut mixed = g.body("Meets at the lab on Fridays");
    mixed["categories"] = json!(["work_context", "location_context"]);
    let (status, error) = g.a.send("POST", "/v1/cloud/memory", Some(mixed)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["errorCode"], "memory_category_not_shared");
    let (_, list) = g.a.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(list["memories"], json!([]), "nothing was written");

    let mut shared = g.body("Ship the beta on Friday");
    shared["categories"] = json!(["work_context", "coordination_context"]);
    let (status, saved) = g.a.send("POST", "/v1/cloud/memory", Some(shared)).await;
    assert_eq!(status, StatusCode::CREATED, "{saved}");
    assert_eq!(
        saved["memory"]["categories"],
        json!(["work_context", "coordination_context"])
    );
    assert_eq!(saved["memory"]["profileIds"], json!([]));
    let memory_id = saved["memory"]["memoryId"].as_str().unwrap().to_string();

    let (status, error) = patch(
        &g.b,
        &memory_id,
        json!({ "categories": ["coordination_context", "health_context"] }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["errorCode"], "memory_category_not_shared");
    let (status, edited) = patch(
        &g.b,
        &memory_id,
        json!({ "category": "goals_and_constraints" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(
        edited["memory"]["categories"],
        json!(["goals_and_constraints", "coordination_context"])
    );
    g.cleanup().await;
}

#[tokio::test]
async fn runner_saves_accept_several_categories() {
    let Some(fx) = fixture().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", RUNNER_TOKEN);
    let runner_id = format!("runner_{}", uuid::Uuid::new_v4().simple());
    let run_id = fx.leased_run(&runner_id).await;
    let body = with(
        "Deploys need a green smoke test before Friday",
        json!({
            "scopeId": "memory-test-session",
            "categories": ["hcp-custom:task_lessons", "work_context"],
            "runnerId": runner_id,
        }),
    );
    let (status, saved) = fx
        .send_with_auth(
            "POST",
            &format!("/v1/cloud/agent-runs/{run_id}/memory"),
            Some(body),
            &format!("Bearer {RUNNER_TOKEN}"),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{saved}");
    assert_eq!(
        kinds(&saved["memory"]),
        (
            json!("hcp-custom:task_lessons"),
            json!(["hcp-custom:task_lessons", "work_context"]),
            json!("medium")
        )
    );
    let (status, list) = fx
        .send_with_auth(
            "GET",
            &format!("/v1/cloud/agent-runs/{run_id}/memory?runnerId={runner_id}"),
            None,
            &format!("Bearer {RUNNER_TOKEN}"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["memories"][0]["sensitivity"], "medium");
    assert_eq!(
        fx.audit_metadata("memory_saved").await.last().unwrap()["categories"],
        json!(["hcp-custom:task_lessons", "work_context"])
    );
    fx.cleanup().await;
}
