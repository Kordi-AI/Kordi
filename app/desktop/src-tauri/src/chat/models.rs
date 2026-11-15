//! Stable DTOs exposed by desktop chat commands and internal adapters.

use kordi_cli::desktop_runtime::{
    DesktopChatAgentProfile, DesktopChatModelOption, DesktopChatProjectGroup,
    DesktopChatSessionDetail, DesktopChatSessionSummary, DesktopChatSlashCommand,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopStoredChatAttachment {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub mime_type: Option<String>,
    pub format_label: Option<String>,
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatState {
    pub cwd: String,
    pub active_session_id: String,
    pub sessions: Vec<DesktopChatSessionSummary>,
    pub projects: Vec<DesktopChatProjectGroup>,
    pub active_session: DesktopChatSessionDetail,
    pub local_agent: DesktopChatAgentProfile,
    pub model_options: Vec<DesktopChatModelOption>,
    pub slash_commands: Vec<DesktopChatSlashCommand>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatToolSnapshot {
    pub id: String,
    pub name: String,
    pub status: String,
    pub arguments: String,
    pub live_output: String,
    pub result_text: Option<String>,
    pub detail: Option<String>,
    pub artifact_path: Option<String>,
    pub tool_layer: Option<String>,
    pub is_error: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatTurnSnapshot {
    pub id: String,
    pub session_id: String,
    pub prompt: String,
    pub status: String,
    pub message: String,
    pub assistant_text: String,
    pub thinking_text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub segments: Vec<kordi_core::types::TurnSegment>,
    pub tools: Vec<DesktopChatToolSnapshot>,
    pub completed: bool,
    pub succeeded: bool,
    pub started_at_ms: i64,
    pub completed_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_entry_id: Option<String>,
    pub error: Option<String>,
    /// The provider's cleaned reason while the runtime retries a failed request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_reason: Option<String>,
    pub transcript_refresh_required: bool,
    /// Set on a runtime follow-up turn that reports a background session's outcome.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_follow_up: Option<DesktopBackgroundFollowUp>,
    /// Why the turn was stopped, recorded by whatever stopped it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<DesktopTurnStopReason>,
}

/// Why a turn was stopped. The first reason recorded for a turn wins.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTurnStopReason {
    /// `user` (a person's Stop), `agent` (the parent agent closed the task),
    /// `lease_lapsed` (nothing renewed the execution lease), `signed_out`,
    /// `account_changed`, `continued_elsewhere` (a follow-up took the task
    /// over), `app_quit`, or a cloud-side stop (`group_closed`,
    /// `access_revoked`, `cloud`).
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// The last update the cloud refused before the lease lapsed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// An update of a background session the cloud answered and refused.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSyncRefusal {
    pub status: u16,
    pub code: String,
}

const STOP_REASON_KINDS: &[&str] = &[
    "user",
    "agent",
    "lease_lapsed",
    "signed_out",
    "account_changed",
    "continued_elsewhere",
    "app_quit",
    "group_closed",
    "access_revoked",
    "cloud",
];

impl DesktopTurnStopReason {
    pub fn of_kind(kind: &str) -> Self {
        Self {
            kind: kind.to_string(),
            account_id: None,
            status: None,
            code: None,
        }
    }

    /// The execution lease lapsed, with the last update the cloud refused.
    pub fn lease_lapsed(refusal: Option<&DesktopSyncRefusal>) -> Self {
        Self {
            status: refusal.map(|refusal| refusal.status),
            code: refusal.map(|refusal| refusal.code.clone()),
            ..Self::of_kind("lease_lapsed")
        }
    }

    /// A reason the web view supplied, reduced to known kinds and short fields.
    pub fn sanitized(self) -> Option<Self> {
        if !STOP_REASON_KINDS.contains(&self.kind.as_str()) {
            return None;
        }
        let short = |value: Option<String>| {
            value.filter(|value| !value.is_empty() && value.chars().count() <= 64)
        };
        Some(Self {
            account_id: short(self.account_id),
            code: short(self.code),
            status: self.status.filter(|status| (100..=599).contains(status)),
            kind: self.kind,
        })
    }

    /// How the parent agent's follow-up names this reason, after "was stopped".
    pub fn follow_up_phrase(&self) -> String {
        match self.kind.as_str() {
            "user" => " by the owner".to_string(),
            "agent" => " by the agent".to_string(),
            "lease_lapsed" => match refusal_label(self.status, self.code.as_deref()) {
                Some(label) => format!(": the cloud refused its updates ({label})"),
                None => ": the app stopped renewing it".to_string(),
            },
            "signed_out" => ": the owner signed out".to_string(),
            "account_changed" => ": the account changed".to_string(),
            "continued_elsewhere" => ": a follow-up continued it elsewhere".to_string(),
            "app_quit" => ": the app quit".to_string(),
            "group_closed" => ": the group was closed".to_string(),
            "access_revoked" => ": access was revoked".to_string(),
            _ => " from another device".to_string(),
        }
    }
}

/// A short label for a refused update, e.g. "version conflict".
pub(crate) fn refusal_label(status: Option<u16>, code: Option<&str>) -> Option<String> {
    let label = match (status, code) {
        (_, Some("subsession_version_conflict")) => "version conflict".to_string(),
        (_, Some("subsession_is_terminal")) => "already finished".to_string(),
        (Some(401), _) => "sign-in expired".to_string(),
        (Some(413), _) => "update too large".to_string(),
        (status, Some(code)) if !code.is_empty() && code != "unknown" => {
            let code = code.trim_start_matches("subsession_").replace('_', " ");
            status.map_or(code.clone(), |status| format!("{status} {code}"))
        }
        (Some(status), _) => format!("HTTP {status}"),
        (None, _) => return None,
    };
    Some(label)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBackgroundFollowUp {
    /// Stable identity: the follow-up entry id, unique per session and outcome.
    pub id: String,
    pub session_id: String,
    pub parent_request_id: Option<String>,
    pub title: String,
    pub status: String,
    /// Where the webview publishes the reply, as it registered it when the
    /// parent request started. Kept here so a reloaded webview can still
    /// publish it; opaque to Rust.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<serde_json::Value>,
    /// Set once the webview has published the reply, so a reloaded webview
    /// does not publish it again.
    pub published: bool,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatMessageRoute {
    pub model: Option<String>,
    pub auth_provider: Option<String>,
    pub auth_choice: Option<String>,
    pub thinking: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatArtifactPreviewLine {
    pub number: usize,
    pub text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatArtifactPreview {
    pub path: String,
    pub lines: Vec<DesktopChatArtifactPreviewLine>,
    pub truncated: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopArtifactDirectoryEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub is_directory: bool,
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopArtifactDirectory {
    pub path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<DesktopArtifactDirectoryEntry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatForkSessionResult {
    pub state: DesktopChatState,
    pub forked_session_id: String,
    pub source_session_id: String,
    pub source_message_id: String,
    pub selected_text: String,
    pub canonical_only: bool,
}
