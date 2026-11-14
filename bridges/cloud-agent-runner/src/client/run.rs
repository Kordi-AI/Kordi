//! The run a lease hands the runner.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudAgentRun {
    #[serde(rename = "agentCommunication", default)]
    pub agent_communication: bool,
    /// The server lets this run open and update plan and vote cards.
    #[serde(rename = "planCards", default)]
    pub plan_cards: bool,
    #[serde(
        rename = "turnIdentity",
        default,
        deserialize_with = "lenient_identity"
    )]
    pub turn_identity: Option<kordi_core::types::RuntimeIdentity>,
    #[serde(rename = "historyMessages", default)]
    pub history_messages: Vec<serde_json::Value>,
    #[serde(rename = "subsessionId", default)]
    pub subsession_id: Option<String>,
    #[serde(rename = "subsessionWriteScope", default)]
    pub subsession_write_scope: Vec<String>,
    #[serde(rename = "runId")]
    pub run_id: String,
    pub status: String,
    pub prompt: String,
    #[serde(rename = "systemPrompt", default)]
    pub system_prompt: String,
    #[serde(rename = "ownerAccountId")]
    pub owner_account_id: String,
    #[serde(rename = "requesterAccountId")]
    pub requester_account_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "sandboxId")]
    pub sandbox_id: Option<String>,
    #[serde(rename = "runtimeRoute", default)]
    pub runtime_route: AgentRuntimeRoute,
    #[serde(rename = "providerAuthAvailable")]
    pub provider_auth_available: bool,
    /// The owner's saved account for this route needs signing in again.
    #[serde(rename = "providerAuthNeedsReconnect", default)]
    pub provider_auth_needs_reconnect: bool,
    /// `trigger` and `connectorTools` from the lease; never a credential.
    #[serde(flatten)]
    pub connectors: crate::connectors::LeaseConnectors,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRuntimeRoute {
    #[serde(rename = "defaultModel")]
    pub default_model: Option<String>,
    pub thinking: Option<String>,
}

/// Reads the turn identity without letting it reject the whole lease. An
/// account may have no display name, so a missing name gets the label the
/// server uses; an identity that still does not fit is left out.
fn lenient_identity<'de, D>(
    deserializer: D,
) -> Result<Option<kordi_core::types::RuntimeIdentity>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let Some(mut value) = Option::<serde_json::Value>::deserialize(deserializer)? else {
        return Ok(None);
    };
    if let Some(object) = value.as_object_mut() {
        for field in ["agentName", "ownerName", "requesterName"] {
            if object.get(field).is_none_or(serde_json::Value::is_null) {
                object.insert(field.to_string(), "Participant".into());
            }
        }
    }
    match serde_json::from_value(value) {
        Ok(identity) => Ok(Some(identity)),
        Err(_) => {
            tracing::warn!("cloud run lease carried an unreadable turn identity; ignoring it");
            Ok(None)
        }
    }
}
