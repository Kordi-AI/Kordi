//! Plan and vote cards for a person's agent run on this Mac (issue #2446).
//! The server binds each call to the run's lease and conversation; the Mac
//! only forwards it.
use crate::cloud_session_organization::CloudBearerAuth;
use kordi_cli::desktop_runtime::DesktopCloudExecutionLease;
use kordi_core::error::{KordiError, KordiResult};
use kordi_tools::{PlanCardRequest, PlanCardRuntime};
use serde_json::{json, Value};
use std::sync::Arc;

fn unavailable() -> KordiError {
    KordiError::Tool(
        "The plan card could not be saved or this execution lease expired. Do not claim a card was opened."
            .into(),
    )
}

struct Transport {
    lease: DesktopCloudExecutionLease,
    endpoint: String,
    client: reqwest::Client,
}

impl Transport {
    async fn call(&self, action: &str, id: &str, arguments: Value) -> KordiResult<Value> {
        let token = crate::cloud_session_refresh::fresh_token_for(&self.lease.owner_account_id)
            .await
            .ok_or_else(unavailable)?;
        let response = self
            .client
            .post(&self.endpoint)
            .cloud_bearer_auth(token)
            .json(&json!({"claimId": self.lease.claim_id, "action": action, "toolCallId": id, "arguments": arguments}))
            .send()
            .await
            .map_err(|_| unavailable())?;
        let status = response.status();
        let body: Value = response.json().await.map_err(|_| unavailable())?;
        if status.is_success() {
            return Ok(body);
        }
        // The server's reason (a second card for the task, an invalid time)
        // tells the model how to correct the call.
        match body["message"]
            .as_str()
            .filter(|message| !message.is_empty())
        {
            Some(message) if status.is_client_error() => Err(KordiError::Tool(format!(
                "The plan card was not saved: {message}"
            ))),
            _ => Err(unavailable()),
        }
    }
}

/// The runtime for a cloud-leased turn whose run may open cards, or `None`
/// (no lease, an older backend, or a run the server does not allow).
pub(super) async fn build(lease: Option<&DesktopCloudExecutionLease>) -> Option<PlanCardRuntime> {
    let lease = lease?.clone();
    let base = crate::cloud_api_base_url_from_env().ok()?;
    let transport = Arc::new(Transport {
        endpoint: format!(
            "{}/v1/cloud/agent-runs/desktop/{}/plan-card",
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
    let capabilities = transport.call("capabilities", "", json!({})).await.ok()?;
    if capabilities["available"] != true {
        return None;
    }
    Some(PlanCardRuntime {
        call: Arc::new(move |request: PlanCardRequest| {
            let transport = transport.clone();
            Box::pin(async move {
                let id = request.tool_call_id.clone().unwrap_or_default();
                transport
                    .call(&request.action, &id, request.arguments)
                    .await
            })
        }),
    })
}
