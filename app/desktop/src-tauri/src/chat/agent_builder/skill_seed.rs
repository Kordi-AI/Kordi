//! Installed skills for Factory drafts. A seed names an agent's loaded skills
//! without their content, so a draft starts from the owner's installed
//! SKILL.md instead of a generated placeholder. Only SKILL.md is copied: a
//! published agent carries one content string per skill.

use std::fs;
use std::path::Path;
use std::sync::OnceLock;

use kordi_cli::skill_library::{self, SkillLibraryEntry};

use super::models::DesktopAgentBuilderAgentFile;
use super::storage::write_json;
use super::validation::{
    frontmatter_field, frontmatter_name, read_limited, skill_path, workspace_fingerprint,
};
use super::workspace::{
    checked_draft_file_path, clean_slug, is_placeholder_skill_content, normalized_skill_description,
};
use super::{AGENT_FILE, MAX_AGENT_BYTES, MAX_FINGERPRINT_BYTES, MAX_SKILLS, MAX_SKILL_BYTES};

/// Installed skill content keeps a draft well under its total size cap.
const SEEDED_SKILL_BUDGET: u64 = MAX_FINGERPRINT_BYTES / 2;
/// `agent.json` holds every description, so a long one is not copied.
const MAX_DESCRIPTION_CHARS: usize = 1024;

/// An installed skill: its description and its SKILL.md.
pub(super) struct InstalledSkill {
    pub(super) description: String,
    pub(super) content: String,
}

/// Finds the installed skill for a draft skill slug.
pub(super) type ResolveSkill<'a> = dyn Fn(&str) -> Option<InstalledSkill> + 'a;

/// Finds skills in the owner's skill library, as the runtime does. The
/// library is listed on the first lookup only, because listing scans the disk.
pub(super) fn installed_skill_resolver() -> impl Fn(&str) -> Option<InstalledSkill> {
    let library = OnceLock::<Vec<SkillLibraryEntry>>::new();
    move |slug: &str| {
        let entries = library.get_or_init(|| {
            std::env::current_dir()
                .ok()
                .and_then(|cwd| skill_library::list_skills(&cwd).ok())
                .unwrap_or_default()
        });
        let entry = entries
            .iter()
            .find(|entry| clean_slug(&entry.name) == slug)?;
        Some(InstalledSkill {
            description: entry.description.clone(),
            // An unreadable or oversized SKILL.md leaves only the description.
            content: read_limited(Path::new(&entry.source_path), MAX_SKILL_BYTES)
                .unwrap_or_default(),
        })
    }
}

/// What a draft skill takes from its installed skill.
pub(super) struct SeededSkill {
    /// The installed SKILL.md, when it passes draft validation and fits.
    pub(super) content: Option<String>,
    /// The installed description, when it is short enough.
    pub(super) description: Option<String>,
}

/// Resolves installed skills for one draft and keeps their total size within
/// `SEEDED_SKILL_BUDGET`; a skill past the budget keeps its generated stub.
pub(super) struct SkillSeeder<'a> {
    resolve: &'a ResolveSkill<'a>,
    used_bytes: u64,
}

impl<'a> SkillSeeder<'a> {
    pub(super) fn new(resolve: &'a ResolveSkill<'a>, used_bytes: u64) -> Self {
        Self {
            resolve,
            used_bytes,
        }
    }

    /// Counts skill content the draft gets from its seed.
    pub(super) fn reserve(&mut self, bytes: usize) {
        self.used_bytes = self.used_bytes.saturating_add(bytes as u64);
    }

    pub(super) fn seed(&mut self, slug: &str) -> Option<SeededSkill> {
        let installed = (self.resolve)(slug)?;
        let description = Some(installed.description.trim())
            .filter(|value| !value.is_empty() && value.chars().count() <= MAX_DESCRIPTION_CHARS)
            .map(str::to_string);
        let content = format!("{}\n", installed.content.trim());
        let bytes = content.len() as u64;
        let fits = self.used_bytes.saturating_add(bytes) <= SEEDED_SKILL_BUDGET;
        let content = (fits && passes_skill_validation(&content, slug)).then(|| {
            self.used_bytes += bytes;
            content
        });
        Some(SeededSkill {
            content,
            description,
        })
    }
}

/// Mirrors `validate_declared_skill`, so a copied skill never makes the draft
/// invalid.
fn passes_skill_validation(content: &str, slug: &str) -> bool {
    content.len() as u64 <= MAX_SKILL_BYTES
        && frontmatter_name(content).as_deref() == Some(slug)
        && frontmatter_field(content, "description").is_some_and(|value| !value.trim().is_empty())
}

/// Replaces each declared skill that is still an untouched generated
/// placeholder with its installed skill, and a generated description with
/// the installed one. An edited skill is never replaced, and nothing is
/// written when no skill qualifies, so the draft keeps its fingerprint.
pub(super) fn upgrade_placeholder_skills(
    workspace: &Path,
    resolve: &ResolveSkill<'_>,
) -> Result<(), String> {
    // Validation reports an unreadable agent.json.
    let Ok(agent_path) = checked_draft_file_path(workspace, AGENT_FILE) else {
        return Ok(());
    };
    let Some(mut agent) = read_limited(&agent_path, MAX_AGENT_BYTES)
        .ok()
        .and_then(|text| serde_json::from_str::<DesktopAgentBuilderAgentFile>(&text).ok())
    else {
        return Ok(());
    };
    let placeholders = agent
        .skills
        .iter()
        .enumerate()
        .take(MAX_SKILLS)
        .filter_map(|(index, skill)| {
            let slug = clean_slug(&skill.name);
            let relative = skill_path(skill).ok()?;
            let path = checked_draft_file_path(workspace, &relative.to_string_lossy()).ok()?;
            let content = read_limited(&path, MAX_SKILL_BYTES).ok()?;
            is_placeholder_skill_content(&content, &slug).then_some((index, slug, path))
        })
        .collect::<Vec<_>>();
    if placeholders.is_empty() {
        return Ok(());
    }
    // A draft that already breaks its limits is left to validation.
    let Some(used_bytes) = workspace_bytes(workspace) else {
        return Ok(());
    };
    let mut seeder = SkillSeeder::new(resolve, used_bytes);
    let mut agent_changed = false;
    for (index, slug, path) in placeholders {
        let Some(SeededSkill {
            content: Some(content),
            description,
        }) = seeder.seed(&slug)
        else {
            continue;
        };
        fs::write(&path, content)
            .map_err(|error| format!("Unable to write {}: {error}", path.display()))?;
        let skill = &mut agent.skills[index];
        let current = skill.description.trim();
        let generated = current.is_empty() || current == normalized_skill_description("", &slug);
        if let Some(description) = description.filter(|_| generated) {
            skill.description = description;
            agent_changed = true;
        }
    }
    if agent_changed {
        write_json(&agent_path, &agent)?;
    }
    Ok(())
}

/// The draft's total file size, or `None` when it cannot be measured within
/// the draft limits.
fn workspace_bytes(workspace: &Path) -> Option<u64> {
    let (_, files) = workspace_fingerprint(workspace).ok()?;
    files
        .iter()
        .map(|relative| {
            fs::metadata(workspace.join(relative))
                .ok()
                .map(|metadata| metadata.len())
        })
        .sum()
}
