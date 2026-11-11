//! Memory categories, declaration types and profile routing (#1977).
//!
//! Every memory carries one to three HCP categories that say what kind of
//! information it is, in the order given; the first is the primary category.
//! The categories decide which Grounding profile kinds the memory is filed
//! to by default (every kind any of them routes to); an explicit card the
//! person chose wins. Group memories describe the group, so they never route
//! to a profile and may not use the categories that describe one person.
//! Each category has a sensitivity level, and a memory's sensitivity is the
//! highest of its categories (metadata only for now).

use axum::http::StatusCode;

use super::{MemoryError, MemoryResult, SaveMemoryRequest};

pub(crate) const MEMORY_CATEGORIES: [&str; 10] = [
    "general_preferences",
    "goals_and_constraints",
    "health_context",
    "education_learner_profile",
    "work_context",
    "purchase_history_preferences",
    "values_and_ethics",
    "location_context",
    "coordination_context",
    "hcp-custom:task_lessons",
];
/// The category of a memory saved without one.
pub(crate) const DEFAULT_CATEGORY: &str = "general_preferences";
/// The most categories one memory may carry.
pub(crate) const MAX_CATEGORIES: usize = 3;
/// Sensitivity levels, lowest first.
pub(crate) const SENSITIVITY_LEVELS: [&str; 3] = ["low", "medium", "high"];
pub(crate) const MEMORY_CONFIDENCES: [&str; 3] = ["low", "medium", "high"];
/// The confidence of an inferred memory saved without one.
pub(crate) const DEFAULT_CONFIDENCE: &str = "medium";
pub(crate) const USER_DECLARED: &str = "user-declared";
pub(crate) const MODEL_INFERRED: &str = "model-inferred";

/// The profile kind a category routes to by default: `all` means every
/// fixed-kind profile; `None` means the memory stays prompt-only.
pub(crate) fn profile_kind_for(category: &str) -> Option<&'static str> {
    match category {
        "work_context" | "education_learner_profile" => Some("work"),
        "health_context" => Some("health"),
        "location_context" | "purchase_history_preferences" => Some("daily"),
        "coordination_context" => Some("all"),
        _ => None,
    }
}

/// Profile kinds that receive memories by category.
pub(crate) const FIXED_PROFILE_KINDS: [&str; 3] = ["work", "health", "daily"];

/// SQL that is true when a memory with the categories array `categories`
/// reaches a profile of kind `kind` through its categories: the profile is
/// of a fixed kind and any of the categories routes to that kind or to every
/// fixed kind.
pub(crate) fn routed_card_sql(categories: &str, kind: &str) -> String {
    let arms: String = MEMORY_CATEGORIES
        .iter()
        .filter_map(|c| profile_kind_for(c).map(|k| format!(" WHEN '{c}' THEN '{k}'")))
        .collect();
    let fixed = FIXED_PROFILE_KINDS
        .iter()
        .map(|k| format!("'{k}'"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "({kind} IN ({fixed}) AND EXISTS (SELECT 1 FROM unnest({categories}) AS routed(category) \
         WHERE (CASE routed.category{arms} END) IN ({kind}, 'all')))"
    )
}

/// Whether a memory with `categories` reaches a profile of `kind` through
/// any of its categories (the Rust twin of [`routed_card_sql`]).
pub(crate) fn routed_to_kind<S: AsRef<str>>(categories: &[S], kind: &str) -> bool {
    FIXED_PROFILE_KINDS.contains(&kind)
        && categories.iter().any(|category| {
            matches!(profile_kind_for(category.as_ref()), Some(k) if k == kind || k == "all")
        })
}

/// Whether any of the categories routes to every fixed profile kind.
pub(crate) fn routes_to_every_kind<S: AsRef<str>>(categories: &[S]) -> bool {
    categories
        .iter()
        .any(|category| profile_kind_for(category.as_ref()) == Some("all"))
}

/// Whether a group memory may use the category. Health, location, purchases
/// and values describe one person, not a group.
pub(crate) fn category_allowed_in_group(category: &str) -> bool {
    !matches!(
        category,
        "health_context"
            | "location_context"
            | "purchase_history_preferences"
            | "values_and_ethics"
    )
}

/// Whether a group memory may use every one of the categories.
pub(crate) fn categories_allowed_in_group<S: AsRef<str>>(categories: &[S]) -> bool {
    categories
        .iter()
        .all(|category| category_allowed_in_group(category.as_ref()))
}

/// Whether any of the categories is health: such a memory is treated as a
/// health memory everywhere health is special-cased.
pub(crate) fn is_health<S: AsRef<str>>(categories: &[S]) -> bool {
    categories
        .iter()
        .any(|category| category.as_ref() == "health_context")
}

/// How sensitive information of the category is. A custom category is
/// never low.
pub(crate) fn category_sensitivity(category: &str) -> &'static str {
    match category {
        "general_preferences" | "goals_and_constraints" | "purchase_history_preferences" => "low",
        "health_context" => "high",
        _ => "medium",
    }
}

/// A memory's sensitivity: the highest of its categories' levels. A memory
/// with no categories is low.
pub(crate) fn memory_sensitivity<S: AsRef<str>>(categories: &[S]) -> &'static str {
    categories
        .iter()
        .map(|category| category_sensitivity(category.as_ref()))
        .max_by_key(|level| SENSITIVITY_LEVELS.iter().position(|known| known == level))
        .unwrap_or("low")
}

/// The profile kind a memory is effectively filed to: the explicit
/// profile's kind when the person chose one, else the category's default.
/// Group memories are never filed to a profile.
pub(crate) fn effective_profile_kind(
    scope: &str,
    category: &str,
    explicit_kind: Option<String>,
) -> Option<String> {
    if scope == "group" {
        return None;
    }
    explicit_kind.or_else(|| profile_kind_for(category).map(str::to_owned))
}

pub(crate) fn invalid_category() -> MemoryError {
    MemoryError::bad_request(
        "invalid_category",
        "category must be one of the memory categories, and categories one to three of them.",
    )
}

pub(crate) fn invalid_confidence() -> MemoryError {
    MemoryError::bad_request(
        "invalid_confidence",
        "confidence must be low, medium, or high.",
    )
}

pub(crate) fn invalid_declared_by() -> MemoryError {
    MemoryError::bad_request("invalid_declared_by", "declaredBy must be user or agent.")
}

pub(crate) fn invalid_update() -> MemoryError {
    MemoryError::bad_request(
        "invalid_update",
        "Send at least one of text, categories, category, profileId, addProfileId, or removeProfileId.",
    )
}

pub(crate) fn memory_profile_not_found() -> MemoryError {
    MemoryError::new(
        StatusCode::NOT_FOUND,
        "memory_profile_not_found",
        "This memory is not on that profile.",
    )
}

pub(crate) fn category_not_shared() -> MemoryError {
    MemoryError::new(
        StatusCode::FORBIDDEN,
        "memory_category_not_shared",
        "This kind of memory describes one person and cannot be saved for a group.",
    )
}

pub(crate) fn profile_not_allowed() -> MemoryError {
    MemoryError::new(
        StatusCode::FORBIDDEN,
        "memory_profile_not_allowed",
        "Group memories cannot be filed to a profile.",
    )
}

pub(crate) fn profile_not_found() -> MemoryError {
    MemoryError::new(
        StatusCode::NOT_FOUND,
        "profile_not_found",
        "Profile was not found.",
    )
}

/// A checked category. Missing or empty uses the default when `default` is
/// true; an unknown value is refused.
pub(crate) fn check_category(value: Option<&str>, default: bool) -> MemoryResult<&'static str> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None if default => Ok(DEFAULT_CATEGORY),
        None => Err(invalid_category()),
        Some(value) => MEMORY_CATEGORIES
            .iter()
            .copied()
            .find(|category| *category == value)
            .ok_or_else(invalid_category),
    }
}

/// Checked categories: each trimmed and known, repeats removed keeping the
/// first occurrence, in the order given, one to three of them.
pub(crate) fn check_categories<S: AsRef<str>>(values: &[S]) -> MemoryResult<Vec<&'static str>> {
    let mut categories: Vec<&'static str> = Vec::new();
    for value in values {
        let category = check_category(Some(value.as_ref()), false)?;
        if !categories.contains(&category) {
            categories.push(category);
        }
    }
    if categories.is_empty() || categories.len() > MAX_CATEGORIES {
        return Err(invalid_category());
    }
    Ok(categories)
}

/// The categories of a save: `categories` when sent, else the legacy single
/// `category`, else the default.
pub(crate) fn save_categories(
    categories: Option<&[String]>,
    category: Option<&str>,
) -> MemoryResult<Vec<&'static str>> {
    match categories {
        Some(categories) => check_categories(categories),
        None => Ok(vec![check_category(category, true)?]),
    }
}

/// The categories after an edit, or `None` when the edit leaves them alone.
/// `categories` replaces the whole set; the legacy `category` replaces only
/// the primary and keeps the others (a repeat of the new primary is
/// dropped). `categories` wins when both are sent.
pub(crate) fn edited_categories<S: AsRef<str>>(
    current: &[S],
    categories: Option<&[String]>,
    category: Option<&str>,
) -> MemoryResult<Option<Vec<&'static str>>> {
    if let Some(categories) = categories {
        return check_categories(categories).map(Some);
    }
    let Some(category) = category else {
        return Ok(None);
    };
    let primary = check_category(Some(category), false)?;
    let mut next = vec![primary];
    for existing in current.iter().skip(1) {
        // Stored values are already checked; an unknown one is dropped.
        let Ok(existing) = check_category(Some(existing.as_ref()), false) else {
            continue;
        };
        if !next.contains(&existing) && next.len() < MAX_CATEGORIES {
            next.push(existing);
        }
    }
    Ok(Some(next))
}

/// The checked categories, declaration type and confidence of a save.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SaveFields {
    /// One to three categories; the first is the primary.
    pub categories: Vec<&'static str>,
    pub declaration_type: &'static str,
    pub confidence: Option<&'static str>,
}

/// Resolves the new fields of a save into `scope`. The declaration comes
/// from `declaredBy` when given, else from the source (`manual` and
/// `import` are the person's own). Inferred memories default to medium confidence; declared
/// ones carry none.
pub(crate) fn save_fields(input: &SaveMemoryRequest, scope: &str) -> MemoryResult<SaveFields> {
    let categories = save_categories(input.categories.as_deref(), input.category.as_deref())?;
    if scope == "group" && !categories_allowed_in_group(&categories) {
        return Err(category_not_shared());
    }
    let declaration_type = match input.declared_by.as_deref().map(str::trim) {
        Some("user") => USER_DECLARED,
        Some("agent") => MODEL_INFERRED,
        Some(_) => return Err(invalid_declared_by()),
        None if matches!(input.source.trim(), "manual" | "import") => USER_DECLARED,
        None => MODEL_INFERRED,
    };
    let confidence = match input.confidence.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(value) => Some(
            MEMORY_CONFIDENCES
                .iter()
                .copied()
                .find(|confidence| *confidence == value)
                .ok_or_else(invalid_confidence)?,
        ),
    };
    let confidence = if declaration_type == MODEL_INFERRED {
        Some(confidence.unwrap_or(DEFAULT_CONFIDENCE))
    } else {
        None
    };
    Ok(SaveFields {
        categories,
        declaration_type,
        confidence,
    })
}

#[cfg(test)]
mod tests {
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
}
