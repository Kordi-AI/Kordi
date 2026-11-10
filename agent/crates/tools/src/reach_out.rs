use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use kordi_core::settings::Settings;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::support::{emit_progress_line, text_result};
use crate::{ReachOutRequest, Tool, ToolContext, ToolMetadata, ToolResult, ToolRiskLevel};

fn default_true() -> bool {
    true
}

fn default_context_policy() -> String {
    "recent-window".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReachOutInput {
    /// Bridge person/agent display name, owner name, node id, human id, or agent id.
    pub target: String,
    /// Optional target kind: agent or person (bridge-agent and bridge-person are aliases).
    pub target_kind: Option<String>,
    /// The question or request to send.
    pub message: String,
    /// Optional extra context to include with the request.
    pub context: Option<String>,
    /// Context-sharing policy for the remote participant.
    #[serde(default = "default_context_policy")]
    pub context_policy: String,
    /// Include concise project context automatically unless explicitly disabled.
    #[serde(default)]
    pub include_project_context: bool,
    /// Wait for the remote reply and return it as this tool result.
    #[serde(default = "default_true")]
    pub wait_for_response: bool,
    /// Maximum time to wait for a response. Defaults to the desktop runtime policy.
    pub timeout_seconds: Option<u64>,
}

/// Stable reach_out guidance for the system prompt of a run in a shared
/// conversation. Whom a run can reach is in the runtime note at the tail of
/// its context, so this text is the same for every run of an agent.
pub const GUIDANCE: &str = "Use reach_out to contact another agent or ask a person in this conversation; target them by agentId or accountId, never by display name, since names can repeat. The runtime note at the end of your context lists whom you can reach for this request, with their exact agentId or accountId and @handle. For a person, set targetKind to person; their next message here, or their reply to your question, is the answer. A request from someone other than your owner may only ask that requester or reach the requester's own agents, and while answering another agent you may only ask your own owner. When the task involves other participants (plans, times, availability, preferences), first reach_out to each other participant's agent (preferred) or to the person for what only they know, and ask the requester with reach_out for what only the requester knows; never end with a list of open questions. If you need information or a decision from the person who asked before you can finish, ask them with reach_out instead of ending your turn with a question; their reply continues the task. Send only the explicit question. The request is already visible in this conversation. Do not add an acknowledgement or waiting message. Follow the receipt to end this turn; the reply automatically resumes the original task, which you own until it has a result. Do not resend or poll.";

pub struct ReachOutTool;

#[async_trait]
impl Tool for ReachOutTool {
    fn name(&self) -> &str {
        "reach_out"
    }

    /// A request from someone other than the owner may still ask: the
    /// runtime exists only under a server lease, and the server limits such a
    /// run to its requester, or to its own owner while answering another agent.
    fn allows_shared_requests(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Send an explicit request to another agent, or ask a person, in the current conversation. Use an exact agent ID, person account ID, or unique @handle from the participant directory, and set targetKind to person when asking a person. A person's next message in the conversation, or their reply to the question, is the answer. In a shared conversation, ask the person who made the request this way, instead of ending the turn with a question, when you need their input to finish; for a request from someone other than your owner, you can ask only them or their own agents. For a task that involves other participants, reach their agent (preferred) or them for their availability or preferences, and the requester for what only they know; never end with a list of open questions. A successful request is durable and returns a receipt. The request is already visible in this conversation. Do not add an acknowledgement or waiting message. Follow the receipt to end this turn; the reply automatically resumes the original task. Never resend or poll while waiting."
    }

    fn parameters_schema(&self) -> Value {
        json!({"type":"object","properties":{
            "target":{"type":"string","description":"Exact agent ID, person account ID, or unique @handle from this conversation's directory."},
            "targetKind":{"type":"string","enum":["agent","person"],"description":"Whether the target is an agent or a person in this conversation. Defaults to whichever one the target names."},
            "message":{"type":"string","description":"The explicit request to share with all conversation members. Never include private files, credentials, or hidden context."}
        },"required":["target","message"],"additionalProperties":false})
    }

    fn metadata(&self) -> ToolMetadata {
        ToolMetadata::operator(ToolRiskLevel::Medium)
    }

    async fn execute(
        &self,
        params: Value,
        ctx: &ToolContext,
        cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        let input: ReachOutInput = serde_json::from_value(params)
            .map_err(|err| KordiError::Tool(format!("Invalid reach_out parameters: {err}")))?;
        validate_input(&input)?;

        let Some(runtime) = ctx.reach_out.clone() else {
            return Err(KordiError::Tool(
                "reach_out is unavailable for this execution lease".to_string(),
            ));
        };

        let context = build_context(&input, ctx);
        let request = ReachOutRequest {
            tool_call_id: ctx.invocation_id.clone(),
            target: input.target.trim().to_string(),
            target_kind: input.target_kind.as_deref().and_then(normalize_target_kind),
            message: input.message.trim().to_string(),
            context,
            context_policy: normalize_context_policy(&input.context_policy)?,
            include_project_context: input.include_project_context,
            wait_for_response: input.wait_for_response,
            timeout_seconds: input.timeout_seconds,
            parent_session_id: None,
            parent_turn_id: None,
            parent_message_id: None,
            project_id: None,
            project_name: None,
        };

        emit_progress_line(ctx, format!("Reaching out to {}…", request.target));

        let response = tokio::select! {
            result = (runtime.reach_out)(request) => result?,
            _ = cancel.cancelled() => {
                return Err(KordiError::Tool("reach_out cancelled".to_string()));
            }
        };

        let mut lines = Vec::new();
        lines.push(format!(
            "Outreach conversation: {} ({})",
            response.conversation_id, response.target_display_name
        ));
        lines.push(format!("Status: {}", response.status));
        if let Some(owner) = response
            .target_owner_name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            lines.push(format!("Owner: {owner}"));
        }
        if response.timed_out {
            lines.push(
                "Timed out while waiting; the outreach session remains visible and resumable."
                    .to_string(),
            );
        }
        if let Some(text) = response
            .response_text
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            lines.push(String::new());
            lines.push(
                if response.status == "pending" {
                    "Delivery receipt:"
                } else {
                    "Remote response:"
                }
                .to_string(),
            );
            lines.push(text.to_string());
        } else if !response.timed_out {
            lines.push("No response text was returned yet.".to_string());
        }

        Ok(text_result(lines.join("\n"), Some(json!(response))))
    }
}

fn validate_input(input: &ReachOutInput) -> KordiResult<()> {
    if input.target.trim().is_empty() {
        return Err(KordiError::Tool("reach_out target is required".to_string()));
    }
    if input.message.trim().is_empty() {
        return Err(KordiError::Tool(
            "reach_out message is required".to_string(),
        ));
    }
    let _ = normalize_context_policy(&input.context_policy)?;
    if let Some(kind) = input.target_kind.as_deref()
        && !kind.trim().is_empty()
        && normalize_target_kind(kind).is_none()
    {
        return Err(KordiError::Tool(
            "reach_out targetKind must be agent or person".to_string(),
        ));
    }
    Ok(())
}

/// The runtime kind for a requested target kind: `agent` or `person`.
pub fn normalize_target_kind(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "agent" | "bridge-agent" => Some("agent".to_string()),
        "person" | "bridge-person" => Some("person".to_string()),
        _ => None,
    }
}

fn normalize_context_policy(value: &str) -> KordiResult<String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "" => Ok(default_context_policy()),
        "last-message" | "recent-window" | "summary" | "full-session" => Ok(normalized),
        _ => Err(KordiError::Tool(
            "reach_out contextPolicy must be last-message, recent-window, summary, or full-session"
                .to_string(),
        )),
    }
}

fn build_context(input: &ReachOutInput, ctx: &ToolContext) -> Option<String> {
    let mut sections = Vec::new();
    if input.include_project_context
        && let Some(project_context) = build_project_context(ctx)
    {
        sections.push(project_context);
    }
    if let Some(extra) = input
        .context
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        sections.push(format!("Additional context:\n{extra}"));
    }
    (!sections.is_empty()).then(|| sections.join("\n\n"))
}

fn build_project_context(ctx: &ToolContext) -> Option<String> {
    let settings = Settings::load_project(&ctx.cwd);
    let mut lines = Vec::new();
    if let Some(name) = settings
        .project_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("Project: {name}"));
    } else if let Some(name) = ctx.cwd.file_name().and_then(|value| value.to_str()) {
        lines.push(format!("Project: {name}"));
    }
    if let Some(context) = settings
        .project_context
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("Context: {context}"));
    }
    if let Some(system) = settings
        .project_system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("Standing instruction: {system}"));
    }
    if !settings.project_shared_sources.is_empty() {
        let sources = settings
            .project_shared_sources
            .iter()
            .map(|source| {
                [
                    source.label.as_str(),
                    source.detail.as_deref().unwrap_or(""),
                ]
                .into_iter()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join(" — ")
            })
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        if !sources.is_empty() {
            lines.push(format!("Shared sources: {}", sources.join("; ")));
        }
    }
    (!lines.is_empty()).then(|| lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_non_owner_shared_request_may_use_reach_out() {
        let ctx = ToolContext {
            cwd: std::env::temp_dir(),
            artifacts_dir: std::env::temp_dir(),
            model: None,
            execution_policy: crate::ExecutionPolicy::Shared,
            invocation_id: None,
            on_output: None,
            web_search: None,
            reach_out: None,
            reflection: None,
            session_observation: None,
            task_operator: None,
            schedule_task: None,
            mac_local: None,
            execution_mode: crate::ToolExecutionMode::Interactive,
            connector_tools: None,
            request_approval: None,
        };
        assert!(ReachOutTool.allows_shared_requests());
        assert!(crate::ensure_tool_allowed(&ReachOutTool, &ctx).is_ok());
    }

    fn input(kind: Option<&str>) -> ReachOutInput {
        serde_json::from_value(
            json!({"target":"@MayaChen","message":"Which day?","targetKind":kind}),
        )
        .unwrap()
    }

    #[test]
    fn schema_offers_people_and_agents() {
        let schema = ReachOutTool.parameters_schema();
        assert_eq!(
            schema["properties"]["targetKind"]["enum"],
            json!(["agent", "person"])
        );
        assert_eq!(schema["required"], json!(["target", "message"]));
        assert!(ReachOutTool.description().contains("ask a person"));
        assert!(
            ReachOutTool
                .description()
                .contains("ask the person who made the request")
        );
        assert!(
            ReachOutTool
                .description()
                .contains("you can ask only them or their own agents")
        );
        assert!(
            ReachOutTool
                .description()
                .contains("never end with a list of open questions")
        );
    }

    #[test]
    fn target_kinds_accept_tool_and_bridge_spellings() {
        for (kind, expected) in [
            ("person", Some("person")),
            ("Bridge-Person", Some("person")),
            ("agent", Some("agent")),
            ("bridge-agent", Some("agent")),
            ("group", None),
        ] {
            assert_eq!(normalize_target_kind(kind).as_deref(), expected);
        }
        assert!(validate_input(&input(Some("person"))).is_ok());
        assert!(validate_input(&input(None)).is_ok());
        assert!(validate_input(&input(Some("group"))).is_err());
    }
}
