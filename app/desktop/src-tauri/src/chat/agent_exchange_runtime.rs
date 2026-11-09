//! Cloud transports messages; the existing lease still runs tools on the Mac.
use crate::cloud_session_organization::CloudBearerAuth;
use kordi_cli::desktop_runtime::DesktopCloudExecutionLease;
use kordi_core::error::{KordiError, KordiResult};
use kordi_tools::{ReachOutRequest, ReachOutResponse, ReachOutRuntime};
use serde_json::{json, Value};
use std::sync::Arc;

fn unavailable() -> KordiError {
    KordiError::Tool("Agent communication is unavailable or this execution lease expired. Do not claim that a request was sent.".into())
}
struct Transport {
    lease: DesktopCloudExecutionLease,
    endpoint: String,
    client: reqwest::Client,
}
impl Transport {
    async fn call(&self, action: &str, id: &str, args: Value) -> KordiResult<Value> {
        let token = crate::cloud_session_refresh::fresh_token_for(&self.lease.owner_account_id)
            .await
            .ok_or_else(unavailable)?;
        let response=self.client.post(&self.endpoint).cloud_bearer_auth(token).json(&json!({"claimId":self.lease.claim_id,"action":action,"toolCallId":id,"arguments":args})).send().await.map_err(|_|unavailable())?;
        if !response.status().is_success() {
            return Err(unavailable());
        }
        response.json().await.map_err(|_| unavailable())
    }
}

pub(super) async fn build(
    lease: Option<&DesktopCloudExecutionLease>,
    owner_request: bool,
) -> Option<(ReachOutRuntime, String)> {
    if !owner_request {
        return None;
    }
    let lease = lease?.clone();
    let base = crate::cloud_api_base_url_from_env().ok()?;
    let transport = Arc::new(Transport {
        endpoint: format!(
            "{}/v1/cloud/agent-runs/desktop/{}/agent-exchange",
            base.trim_end_matches('/'),
            lease.run_id
        ),
        lease,
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .ok()?,
    });
    // A missing capability on an older backend leaves the tool hidden.
    let capabilities = transport.call("capabilities", "", json!({})).await.ok()?;
    let guidance = guidance(&capabilities)?;
    Some((
        ReachOutRuntime {
            reach_out: Arc::new(move |request: ReachOutRequest| {
                let transport = transport.clone();
                Box::pin(async move {
                    let id = request.tool_call_id.as_deref().ok_or_else(unavailable)?;
                    let response = transport.call("send", id, send_arguments(&request)).await?;
                    Ok(ReachOutResponse {
                        conversation_id: response["exchangeId"]
                            .as_str()
                            .ok_or_else(unavailable)?
                            .into(),
                        target_kind: response["targetKind"].as_str().unwrap_or("agent").into(),
                        target_display_name: response["target"]["name"]
                            .as_str()
                            .unwrap_or("Agent")
                            .into(),
                        target_owner_name: None,
                        response_text: Some(
                            response["message"].as_str().unwrap_or_default().into(),
                        ),
                        status: response["status"].as_str().unwrap_or("pending").into(),
                        timed_out: false,
                    })
                })
            }),
        },
        guidance,
    ))
}

fn listed(value: &Value) -> bool {
    value.as_array().is_some_and(|items| !items.is_empty())
}

/// The directory the agent sees: other agents, and people it may ask. Older
/// backends list no people, so only agents are offered there.
fn guidance(capabilities: &Value) -> Option<String> {
    let agents = listed(&capabilities["targets"]);
    let people = listed(&capabilities["people"]);
    if capabilities["available"] != true || !(agents || people) {
        return None;
    }
    let mut text = String::from("Use reach_out to contact another agent or ask a person in this conversation. Send only the explicit question, never private context or files.");
    if agents {
        text.push_str(&format!(
            " Agents: use an exact agentId or an unambiguous @handle from this directory: {}.",
            capabilities["targets"]
        ));
    }
    if people {
        text.push_str(&format!(
            " People: set targetKind to person and use an exact accountId or an unambiguous @handle from this directory: {}. Their next message in this conversation, or their reply to your question, is the answer.",
            capabilities["people"]
        ));
    }
    text.push_str(" A successful call queues the request. The request is already visible in this conversation. Do not add an acknowledgement or waiting message. Follow the receipt to end this turn; the reply automatically resumes the original task. Do not poll or resend.");
    Some(text)
}

fn send_arguments(request: &ReachOutRequest) -> Value {
    let mut arguments = json!({"target":request.target,"message":request.message});
    if let Some(kind) = request.target_kind.as_deref() {
        arguments["targetKind"] = json!(kind);
    }
    arguments
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn people_are_listed_as_reachable_targets() {
        let both = json!({"available":true,"targets":[{"agentId":"cloud-agent:a","handle":"KordiAlex"}],"people":[{"accountId":"p","name":"Maya","handle":"Maya"}]});
        let text = guidance(&both).unwrap();
        assert!(text.contains("KordiAlex") && text.contains("targetKind to person"));
        assert!(text.contains("\"accountId\":\"p\""));
        let people_only = json!({"available":true,"targets":[],"people":[{"accountId":"p"}]});
        assert!(guidance(&people_only).unwrap().contains("People:"));
        let older = json!({"available":true,"targets":[{"agentId":"cloud-agent:a"}]});
        assert!(!guidance(&older).unwrap().contains("People:"));
        assert!(guidance(&json!({"available":true,"targets":[],"people":[]})).is_none());
        assert!(guidance(&json!({"available":false,"people":[{"accountId":"p"}]})).is_none());
    }

    #[test]
    fn the_target_kind_is_passed_through() {
        let mut request = ReachOutRequest {
            tool_call_id: Some("call".into()),
            target: "@Maya".into(),
            target_kind: Some("person".into()),
            message: "Which day?".into(),
            context: None,
            context_policy: "recent-window".into(),
            include_project_context: false,
            wait_for_response: true,
            timeout_seconds: None,
            parent_session_id: None,
            parent_turn_id: None,
            parent_message_id: None,
            project_id: None,
            project_name: None,
        };
        assert_eq!(
            send_arguments(&request),
            json!({"target":"@Maya","targetKind":"person","message":"Which day?"})
        );
        request.target_kind = None;
        assert!(send_arguments(&request).get("targetKind").is_none());
    }
}
