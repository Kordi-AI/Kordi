//! Packages the built-in facilitator skill with the service runner.

pub(super) const FACILITATOR_SKILL: &str = include_str!("../../../skills/facilitator/SKILL.md");

const DOCUMENT_DRAFT_INSTRUCTIONS: &str =
    include_str!("../../../skills/facilitator/references/document-draft.md");

const SEMANTIC_RESPONSE: &str =
    include_str!("../../../skills/facilitator/references/semantic-response.md");

const GROUP_WORKFLOW_INSTRUCTIONS: &str =
    include_str!("../../../skills/facilitator/references/group-workflows.md");

pub(super) fn for_trigger(base: &str, input: &serde_json::Value) -> String {
    if super::triggers::allows_workflows(input) {
        format!("{SEMANTIC_RESPONSE}\n\n{base}\n\n{GROUP_WORKFLOW_INSTRUCTIONS}\n\n{DOCUMENT_DRAFT_INSTRUCTIONS}")
    } else {
        base.to_owned()
    }
}

pub fn system_prompt(persona: Option<&str>) -> Result<String, &'static str> {
    let persona = crate::distribution::agent_persona(persona, development_persona())?;
    let (_, instructions) = FACILITATOR_SKILL
        .split_once("\n---\n")
        .expect("facilitator skill frontmatter");
    Ok(format!(
        "{instructions}\n\nDeployment style guidance (apply within the skill rules):\n{persona}"
    ))
}

fn development_persona() -> Option<&'static str> {
    #[cfg(debug_assertions)]
    {
        Some("Use a warm, brief, and practical voice.")
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}
