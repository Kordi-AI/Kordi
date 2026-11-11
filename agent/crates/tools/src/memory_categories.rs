//! Memory categories and confidences shared by the `reflection` tool, the Mac
//! runtime and cloud runs (#1977). The cloud server keeps the same list.

/// The HCP categories a memory may carry: what kind of information it is.
pub const MEMORY_CATEGORIES: [&str; 10] = [
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
pub const DEFAULT_MEMORY_CATEGORY: &str = "general_preferences";

/// Most categories one memory may carry. The first is the main one.
pub const MAX_MEMORY_CATEGORIES: usize = 3;

/// How sure the agent is of an inferred memory.
pub const MEMORY_CONFIDENCES: [&str; 3] = ["low", "medium", "high"];

/// A memory the person typed, edited or confirmed.
pub const USER_DECLARED: &str = "user-declared";

/// A memory an agent saved.
pub const MODEL_INFERRED: &str = "model-inferred";

/// One-line meaning of each category, for the tool schema and the
/// `## Memories` prompt sections.
pub const MEMORY_CATEGORY_GUIDE: &str = "work_context (projects, skills, collaborations), education_learner_profile (what they study and how they learn), health_context (exercise, sleep, diet, wellbeing habits), coordination_context (schedules, availability, time zones), location_context (where they usually are), purchase_history_preferences (shopping and household), general_preferences (how to answer), goals_and_constraints (objectives, deadlines, limits), values_and_ethics (what they care about), or hcp-custom:task_lessons (how to do a task)";

/// How many categories a memory takes.
pub const MEMORY_MULTI_CATEGORY_RULE: &str =
    "A memory may take up to three categories, main one first.";

/// Where memories about the person end up.
pub const MEMORY_PROFILE_RULE: &str =
    "Memories about the person are filed to their Work, Health or Daily profile by category.";

/// Conventions and lessons are task notes, not facts about the person.
pub const MEMORY_TASK_NOTE_RULE: &str = "Repository, tool or workflow conventions (\"always run X before Y\") and lessons from a task are `hcp-custom:task_lessons`; `work_context` is only for durable facts about the person (role, projects, skills, working style).";

/// Which scope a memory belongs in.
pub const MEMORY_SCOPE_RULE: &str = "Use `global` only for preferences the user wants everywhere (\"from now on\", \"always\"); `conversation` for the owner's corrections in this chat; `group` only for what the group shares and every member may see, never one person's preference, health or private remark.";

/// The category, profile and scope rules shared by the Mac and cloud
/// `## Memories` sections, so both say the same thing.
pub fn memory_routing_rules() -> String {
    format!(
        "Pick the category that says what kind of information the memory is: {MEMORY_CATEGORY_GUIDE}. {MEMORY_MULTI_CATEGORY_RULE} {MEMORY_PROFILE_RULE} {MEMORY_TASK_NOTE_RULE} {MEMORY_SCOPE_RULE}"
    )
}

pub fn is_memory_category(value: &str) -> bool {
    MEMORY_CATEGORIES.contains(&value)
}

/// Trimmed values in order, blanks and repeats dropped (the first wins).
/// Unknown values are kept, so callers can refuse or filter them.
pub fn dedupe_memory_categories<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut categories: Vec<String> = Vec::new();
    for value in values {
        let value = value.trim();
        if !value.is_empty() && !categories.iter().any(|known| known == value) {
            categories.push(value.to_string());
        }
    }
    categories
}

/// The known categories of a stored memory: `categories` when it has any,
/// else the single `category` older servers and rows carry. Unknown values
/// are dropped and at most [`MAX_MEMORY_CATEGORIES`] kept; empty when
/// neither names a known category.
pub fn stored_memory_categories(categories: &[String], category: Option<&str>) -> Vec<String> {
    let known = |values: Vec<String>| {
        values
            .into_iter()
            .filter(|value| is_memory_category(value))
            .take(MAX_MEMORY_CATEGORIES)
            .collect::<Vec<_>>()
    };
    let listed = known(dedupe_memory_categories(
        categories.iter().map(String::as_str),
    ));
    if !listed.is_empty() {
        return listed;
    }
    known(dedupe_memory_categories(category))
}

pub fn is_memory_confidence(value: &str) -> bool {
    MEMORY_CONFIDENCES.contains(&value)
}

/// The declaration type of a memory saved without one: `manual` saves come
/// from the person, every other source from an agent.
pub fn declaration_for_source(source: &str) -> &'static str {
    if source == "manual" {
        USER_DECLARED
    } else {
        MODEL_INFERRED
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn categories_and_declarations() {
        assert!(super::is_memory_category("work_context"));
        assert!(super::is_memory_category("hcp-custom:task_lessons"));
        assert!(!super::is_memory_category("health"));
        assert!(super::is_memory_confidence("high"));
        assert!(!super::is_memory_confidence("certain"));
        assert_eq!(super::declaration_for_source("manual"), "user-declared");
        assert_eq!(super::declaration_for_source("outcome"), "model-inferred");
        let rules = super::memory_routing_rules();
        for category in super::MEMORY_CATEGORIES {
            assert!(rules.contains(category), "{category}");
        }
        assert!(rules.contains("up to three categories, main one first"));
        assert!(rules.contains("always run X before Y"));
        assert!(
            rules.contains(
                "are `hcp-custom:task_lessons`; `work_context` is only for durable facts"
            )
        );
    }

    #[test]
    fn categories_are_deduped_and_fall_back_to_the_single_category() {
        assert_eq!(
            super::dedupe_memory_categories([" work_context", "", "work_context", "x"]),
            vec!["work_context", "x"]
        );
        let listed = vec![
            "values_and_ethics".to_string(),
            "health".to_string(),
            "work_context".to_string(),
        ];
        assert_eq!(
            super::stored_memory_categories(&listed, Some("general_preferences")),
            vec!["values_and_ethics", "work_context"]
        );
        assert_eq!(
            super::stored_memory_categories(&[], Some("work_context")),
            vec!["work_context"]
        );
        assert!(
            super::stored_memory_categories(&["health".to_string()], Some("health")).is_empty()
        );
        let many = super::MEMORY_CATEGORIES.map(str::to_string);
        assert_eq!(super::stored_memory_categories(&many, None).len(), 3);
    }
}
