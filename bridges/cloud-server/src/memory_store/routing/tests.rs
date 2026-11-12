use super::*;

fn request(source: &str) -> SaveMemoryRequest {
    SaveMemoryRequest {
        scope: "conversation".into(),
        scope_id: "s".into(),
        scope_label: None,
        source: source.into(),
        text: "t".into(),
        client_memory_id: None,
        category: None,
        categories: None,
        confidence: None,
        declared_by: None,
    }
}

#[test]
fn profile_kinds_follow_the_plan() {
    assert_eq!(profile_kind_for("work_context"), Some("work"));
    assert_eq!(profile_kind_for("education_learner_profile"), Some("work"));
    assert_eq!(profile_kind_for("health_context"), Some("health"));
    assert_eq!(profile_kind_for("location_context"), Some("daily"));
    assert_eq!(
        profile_kind_for("purchase_history_preferences"),
        Some("daily")
    );
    assert_eq!(profile_kind_for("coordination_context"), Some("all"));
    for category in [
        "general_preferences",
        "goals_and_constraints",
        "values_and_ethics",
        "hcp-custom:task_lessons",
    ] {
        assert_eq!(profile_kind_for(category), None, "{category}");
    }
    assert_eq!(effective_profile_kind("group", "work_context", None), None);
    assert_eq!(
        effective_profile_kind("global", "work_context", Some("custom".into())),
        Some("custom".into())
    );
}

#[test]
fn routed_to_kind_matches_the_routing_table() {
    assert!(routed_to_kind(&["work_context"], "work"));
    assert!(!routed_to_kind(&["work_context"], "health"));
    assert!(routed_to_kind(&["coordination_context"], "daily"));
    assert!(!routed_to_kind(&["coordination_context"], "custom"));
    assert!(!routed_to_kind(&["general_preferences"], "work"));
    let sql = routed_card_sql("m.categories", "p.kind");
    assert!(sql.contains("unnest(m.categories)"), "{sql}");
    assert!(
        sql.contains("WHEN 'coordination_context' THEN 'all'"),
        "{sql}"
    );
    assert!(
        sql.starts_with("(p.kind IN ('work', 'health', 'daily')"),
        "{sql}"
    );
}

#[test]
fn group_categories_exclude_personal_ones() {
    let refused: Vec<_> = MEMORY_CATEGORIES
        .iter()
        .filter(|category| !category_allowed_in_group(category))
        .collect();
    assert_eq!(
        refused,
        [
            &"health_context",
            &"purchase_history_preferences",
            &"values_and_ethics",
            &"location_context"
        ]
    );
}

#[test]
fn save_fields_derive_declaration_and_confidence() {
    let fields = save_fields(&request("manual"), "global").unwrap();
    assert_eq!(fields.categories, [DEFAULT_CATEGORY]);
    assert_eq!(fields.declaration_type, USER_DECLARED);
    assert_eq!(fields.confidence, None);

    let imported = save_fields(&request("import"), "global").unwrap();
    assert_eq!(imported.declaration_type, USER_DECLARED);
    assert_eq!(imported.confidence, None);
    let digest = save_fields(&request("digest"), "global").unwrap();
    assert_eq!(digest.declaration_type, MODEL_INFERRED);
    assert_eq!(digest.confidence, Some(DEFAULT_CONFIDENCE));

    let mut agent = request("user_correction");
    agent.confidence = Some("high".into());
    agent.category = Some(" work_context ".into());
    let fields = save_fields(&agent, "conversation").unwrap();
    assert_eq!(fields.categories, ["work_context"]);
    assert_eq!(fields.declaration_type, MODEL_INFERRED);
    assert_eq!(fields.confidence, Some("high"));

    let mut declared = request("outcome");
    declared.declared_by = Some("user".into());
    declared.confidence = Some("low".into());
    let fields = save_fields(&declared, "conversation").unwrap();
    assert_eq!(fields.declaration_type, USER_DECLARED);
    assert_eq!(fields.confidence, None);

    let mut bad = request("manual");
    bad.category = Some("diary".into());
    assert_eq!(
        save_fields(&bad, "global").unwrap_err().code,
        "invalid_category"
    );
    let mut bad = request("manual");
    bad.confidence = Some("certain".into());
    assert_eq!(
        save_fields(&bad, "global").unwrap_err().code,
        "invalid_confidence"
    );
    let mut bad = request("manual");
    bad.declared_by = Some("robot".into());
    assert_eq!(
        save_fields(&bad, "global").unwrap_err().code,
        "invalid_declared_by"
    );
    let mut health = request("manual");
    health.category = Some("health_context".into());
    assert_eq!(
        save_fields(&health, "group").unwrap_err().code,
        "memory_category_not_shared"
    );
}

#[test]
fn every_category_has_a_sensitivity() {
    let level = |category| category_sensitivity(category);
    for category in [
        "general_preferences",
        "goals_and_constraints",
        "purchase_history_preferences",
    ] {
        assert_eq!(level(category), "low", "{category}");
    }
    for category in [
        "education_learner_profile",
        "work_context",
        "values_and_ethics",
        "location_context",
        "coordination_context",
        "hcp-custom:task_lessons",
    ] {
        assert_eq!(level(category), "medium", "{category}");
    }
    assert_eq!(level("health_context"), "high");
    assert_eq!(level("hcp-custom:anything_new"), "medium");
    for category in MEMORY_CATEGORIES {
        assert!(SENSITIVITY_LEVELS.contains(&level(category)), "{category}");
    }
}

#[test]
fn a_memory_is_as_sensitive_as_its_most_sensitive_category() {
    assert_eq!(memory_sensitivity(&["general_preferences"]), "low");
    assert_eq!(
        memory_sensitivity(&["general_preferences", "work_context"]),
        "medium"
    );
    assert_eq!(
        memory_sensitivity(&["work_context", "health_context", "goals_and_constraints"]),
        "high"
    );
    assert_eq!(memory_sensitivity::<&str>(&[]), "low");
}

#[test]
fn several_categories_route_to_every_kind_any_of_them_reaches() {
    let both = ["work_context", "health_context"];
    assert!(routed_to_kind(&both, "work"));
    assert!(routed_to_kind(&both, "health"));
    assert!(!routed_to_kind(&both, "daily"));
    assert!(!routed_to_kind(&both, "custom"));
    assert!(routed_to_kind(
        &["general_preferences", "location_context"],
        "daily"
    ));
    assert!(routes_to_every_kind(&[
        "work_context",
        "coordination_context"
    ]));
    assert!(!routes_to_every_kind(&["work_context"]));
    assert!(is_health(&["work_context", "health_context"]));
    assert!(!is_health(&["work_context"]));
}

#[test]
fn a_group_memory_needs_every_category_shared() {
    assert!(categories_allowed_in_group(&[
        "work_context",
        "coordination_context"
    ]));
    assert!(!categories_allowed_in_group(&[
        "work_context",
        "location_context"
    ]));
    let mut mixed = request("manual");
    mixed.categories = Some(vec!["work_context".into(), "health_context".into()]);
    assert_eq!(
        save_fields(&mixed, "group").unwrap_err().code,
        "memory_category_not_shared"
    );
    assert_eq!(
        save_fields(&mixed, "global").unwrap().categories,
        ["work_context", "health_context"]
    );
}

#[test]
fn save_categories_keep_order_and_drop_repeats() {
    let list = |values: &[&str]| values.iter().map(|v| v.to_string()).collect::<Vec<_>>();
    assert_eq!(
        save_categories(
            Some(&list(&[
                " work_context",
                "coordination_context",
                "work_context "
            ])),
            Some("health_context")
        )
        .unwrap(),
        ["work_context", "coordination_context"],
        "categories win over category, trimmed, first occurrence kept"
    );
    assert_eq!(
        save_categories(None, Some("location_context")).unwrap(),
        ["location_context"]
    );
    assert_eq!(save_categories(None, None).unwrap(), [DEFAULT_CATEGORY]);
    assert_eq!(
        save_categories(None, Some(" ")).unwrap(),
        [DEFAULT_CATEGORY]
    );
    for bad in [
        list(&[]),
        list(&["diary"]),
        list(&["work_context", ""]),
        list(&[
            "work_context",
            "health_context",
            "location_context",
            "general_preferences",
        ]),
    ] {
        assert_eq!(
            save_categories(Some(&bad), None).unwrap_err().code,
            "invalid_category",
            "{bad:?}"
        );
    }
    // Four entries with a repeat are three categories.
    assert_eq!(
        save_categories(
            Some(&list(&[
                "work_context",
                "health_context",
                "work_context",
                "location_context"
            ])),
            None
        )
        .unwrap(),
        ["work_context", "health_context", "location_context"]
    );
}

#[test]
fn edits_replace_all_categories_or_only_the_primary() {
    let current = ["work_context", "coordination_context", "location_context"];
    let list = |values: &[&str]| values.iter().map(|v| v.to_string()).collect::<Vec<_>>();
    assert_eq!(edited_categories(&current, None, None).unwrap(), None);
    assert_eq!(
        edited_categories(
            &current,
            Some(&list(&["health_context"])),
            Some("work_context")
        )
        .unwrap(),
        Some(vec!["health_context"]),
        "categories replace the whole set and win over category"
    );
    assert_eq!(
        edited_categories(&current, None, Some("goals_and_constraints")).unwrap(),
        Some(vec![
            "goals_and_constraints",
            "coordination_context",
            "location_context"
        ]),
        "category replaces only the primary"
    );
    assert_eq!(
        edited_categories(&current, None, Some("location_context")).unwrap(),
        Some(vec!["location_context", "coordination_context"]),
        "a repeat of the new primary is dropped"
    );
    assert_eq!(
        edited_categories(&current, None, Some("diary"))
            .unwrap_err()
            .code,
        "invalid_category"
    );
    assert_eq!(
        edited_categories(&current, Some(&list(&[])), None)
            .unwrap_err()
            .code,
        "invalid_category"
    );
}
