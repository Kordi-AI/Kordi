//! Installed skills seeded into Factory drafts, and placeholder upgrades.

use std::cell::RefCell;
use std::path::PathBuf;

use super::*;

fn temp_workspace() -> PathBuf {
    std::env::temp_dir().join(format!("kordi-agent-builder-test-{}", uuid::Uuid::new_v4()))
}

fn installed(name: &str, description: &str) -> InstalledSkill {
    InstalledSkill {
        description: description.to_string(),
        content: format!(
            "---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n\nInstalled instructions for {name}.\n"
        ),
    }
}

fn seed_with_skills(names: &[&str]) -> DesktopAgentBuilderSeed {
    DesktopAgentBuilderSeed {
        name: "Seeded agent".to_string(),
        role: "Test agent".to_string(),
        access: "only-me".to_string(),
        skills: names
            .iter()
            .map(|name| DesktopAgentBuilderSkillSeed {
                name: name.to_string(),
                ..DesktopAgentBuilderSkillSeed::default()
            })
            .collect(),
        ..DesktopAgentBuilderSeed::default()
    }
}

fn draft_skills(workspace: &Path) -> Vec<DesktopAgentBuilderSkillDraft> {
    let (draft, validation) = validate_workspace(workspace);
    assert!(validation.valid, "{:?}", validation.errors);
    draft.expect("validated draft").skills
}

#[test]
fn new_drafts_copy_valid_installed_skills_instead_of_placeholders() {
    let workspace = temp_workspace();
    let calls = RefCell::new(Vec::new());
    let resolve = |slug: &str| {
        calls.borrow_mut().push(slug.to_string());
        (slug != "unknown-skill").then(|| installed(slug, "Review repositories with care"))
    };
    let mut seed = seed_with_skills(&["Repository Review", "unknown-skill", "supplied-skill"]);
    seed.skills[2].description = "From the seed".to_string();
    seed.skills[2].content = Some(
        "---\nname: supplied-skill\ndescription: From the seed\n---\n\nSeed body.".to_string(),
    );
    materialize_seed_with(&workspace, Some(&seed), &resolve).expect("seed draft");

    let skills = draft_skills(&workspace);
    assert_eq!(
        skills[0].content,
        installed("repository-review", "Review repositories with care").content
    );
    assert_eq!(skills[0].description, "Review repositories with care");
    assert!(is_placeholder_skill_content(
        &skills[1].content,
        "unknown-skill"
    ));
    assert_eq!(
        skills[1].description,
        "Use unknown-skill when its focused workflow is required."
    );
    assert_eq!(
        skills[2].content,
        "---\nname: supplied-skill\ndescription: From the seed\n---\n\nSeed body.\n"
    );
    // A skill the seed supplies is never looked up.
    assert_eq!(*calls.borrow(), ["repository-review", "unknown-skill"]);

    // Reopening an existing draft looks nothing up.
    calls.borrow_mut().clear();
    materialize_seed_with(&workspace, Some(&seed), &resolve).expect("reopen draft");
    assert!(calls.borrow().is_empty());
    let _ = fs::remove_dir_all(workspace);
}

#[test]
fn invalid_installed_skills_fall_back_to_stubs_with_safe_descriptions() {
    let workspace = temp_workspace();
    let long_description = "d".repeat(1025);
    let resolve = |slug: &str| match slug {
        // The frontmatter name must equal the draft's skill name.
        "renamed-skill" => Some(InstalledSkill {
            description: "Renamed".to_string(),
            content: installed("Renamed Skill", "Renamed").content,
        }),
        "oversized-skill" => {
            let mut skill = installed(slug, "Oversized");
            skill
                .content
                .push_str(&"x".repeat(MAX_SKILL_BYTES as usize));
            Some(skill)
        }
        "verbose-skill" => Some(installed(slug, &long_description)),
        _ => None,
    };
    let seed = seed_with_skills(&["renamed-skill", "oversized-skill", "verbose-skill"]);
    materialize_seed_with(&workspace, Some(&seed), &resolve).expect("seed draft");

    let skills = draft_skills(&workspace);
    // A stub keeps the installed description, in agent.json and its frontmatter.
    for (skill, description) in skills.iter().zip(["Renamed", "Oversized"]) {
        assert!(skill.content.starts_with(&format!(
            "---\nname: {}\ndescription: \"{description}\"\n---\n",
            skill.name
        )));
        assert!(!is_placeholder_skill_content(&skill.content, &skill.name));
        assert_eq!(skill.description, description);
    }
    // A valid skill is copied, but an overlong description is not.
    assert_eq!(
        skills[2].content,
        installed("verbose-skill", &long_description).content
    );
    assert_eq!(
        skills[2].description,
        "Use verbose-skill when its focused workflow is required."
    );
    let _ = fs::remove_dir_all(workspace);
}

#[test]
fn opening_a_draft_upgrades_only_untouched_placeholders() {
    let workspace = temp_workspace();
    let seed = seed_with_skills(&[
        "Repository Review",
        "release-notes",
        "edited-skill",
        "unknown-skill",
    ]);
    materialize_seed(&workspace, Some(&seed)).expect("seed placeholder draft");
    // The owner reworded one description and edited another skill.
    let agent_path = workspace.join(AGENT_FILE);
    let agent = fs::read_to_string(&agent_path)
        .expect("read agent.json")
        .replace(
            "Use release-notes when its focused workflow is required.",
            "Owner wording",
        );
    fs::write(&agent_path, agent).expect("reword description");
    let edited = workspace.join("skills/edited-skill/SKILL.md");
    let edited_content = format!(
        "{}Keep this owner note.\n",
        fs::read_to_string(&edited).expect("read edited skill")
    );
    fs::write(&edited, &edited_content).expect("edit skill");
    let fingerprint = || workspace_fingerprint(&workspace).expect("fingerprint").0;
    let before = fingerprint();

    upgrade_placeholder_skills(&workspace, &|_| None).expect("upgrade without installed skills");
    assert_eq!(fingerprint(), before);

    let resolve = |slug: &str| {
        (slug != "unknown-skill").then(|| installed(slug, &format!("Installed {slug}")))
    };
    upgrade_placeholder_skills(&workspace, &resolve).expect("upgrade placeholders");
    let skills = draft_skills(&workspace);
    assert_eq!(
        skills[0].content,
        installed("repository-review", "Installed repository-review").content
    );
    assert_eq!(skills[0].description, "Installed repository-review");
    assert_eq!(
        skills[1].content,
        installed("release-notes", "Installed release-notes").content
    );
    assert_eq!(skills[1].description, "Owner wording");
    assert_eq!(skills[2].content, edited_content);
    assert!(is_placeholder_skill_content(
        &skills[3].content,
        "unknown-skill"
    ));

    // Nothing qualifies any more, so a later open writes nothing.
    let upgraded = fingerprint();
    upgrade_placeholder_skills(&workspace, &resolve).expect("upgrade again");
    assert_eq!(fingerprint(), upgraded);
    let _ = fs::remove_dir_all(workspace);
}

#[test]
fn installed_skills_stay_within_the_draft_size_budget() {
    let workspace = temp_workspace();
    let large = 90 * 1024;
    let names = (0..MAX_SKILLS)
        .map(|index| format!("large-skill-{index}"))
        .collect::<Vec<_>>();
    let seed = seed_with_skills(&names.iter().map(String::as_str).collect::<Vec<_>>());
    let resolve = |slug: &str| {
        let mut skill = installed(slug, &format!("Large {slug}"));
        skill.content.push_str(&"x".repeat(large));
        Some(skill)
    };
    materialize_seed_with(&workspace, Some(&seed), &resolve).expect("seed large draft");

    let skills = draft_skills(&workspace);
    let copied = skills
        .iter()
        .take_while(|skill| skill.content.len() > large)
        .count();
    assert!(copied > 0 && copied < MAX_SKILLS, "{copied} skills copied");
    let copied_bytes = skills[..copied]
        .iter()
        .map(|skill| skill.content.len() as u64)
        .sum::<u64>();
    assert!(copied_bytes <= MAX_FINGERPRINT_BYTES / 2);
    // Later skills keep a stub, still with the installed description.
    for skill in &skills[copied..] {
        assert!(skill.content.len() < 1024, "{} was copied", skill.name);
        assert_eq!(skill.description, format!("Large {}", skill.name));
    }
    let _ = fs::remove_dir_all(workspace);
}
