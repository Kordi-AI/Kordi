use async_trait::async_trait;
use serde::{Deserialize, Serialize};

mod artifacts;
mod envelopes;
mod run;
pub use artifacts::{ArtifactExportInput, ArtifactExportResponse};
use envelopes::{
    ArtifactExportEnvelope, HeartbeatEnvelope, LeaseResponse, ProviderAuthEnvelope, RunEnvelope,
};
pub use run::{AgentRuntimeRoute, CloudAgentRun};

use crate::memory::{MemoryRequestError, NewRunnerMemory, RunnerMemory, RunnerMemoryContext};

#[derive(Debug, thiserror::Error)]
pub enum RunnerClientError {
    #[error("cloud runner client request failed: {0}")]
    Request(String),
    /// A failure while the runner held `run_id`.
    #[error("cloud run {run_id} step failed")]
    Run {
        run_id: String,
        #[source]
        source: Box<RunnerClientError>,
    },
}

impl RunnerClientError {
    /// Ties this failure to the run it happened in.
    pub fn for_run(self, run_id: &str) -> Self {
        match self {
            Self::Run { .. } => self,
            other => Self::Run {
                run_id: run_id.to_string(),
                source: Box::new(other),
            },
        }
    }

    /// The run this failure happened in, when known.
    pub fn run_id(&self) -> Option<&str> {
        match self {
            Self::Run { run_id, .. } => Some(run_id),
            Self::Request(_) => None,
        }
    }

    /// This failure and every cause under it, for logs.
    pub fn chain(&self) -> String {
        let mut text = self.to_string();
        let mut source = std::error::Error::source(self);
        while let Some(cause) = source {
            text.push_str(": ");
            text.push_str(&cause.to_string());
            source = cause.source();
        }
        text
    }
}

/// A response body the runner could not read, described without its
/// content: serde quotes the offending string value, which can be prompt or
/// reply text, so quoted parts are left out.
fn parse_failure(path: &str, error: &serde_json::Error) -> RunnerClientError {
    let mut message = String::new();
    let mut quoted = false;
    for part in error.to_string().split('"') {
        if !quoted {
            message.push_str(part);
        } else {
            message.push_str("<redacted>");
        }
        quoted = !quoted;
    }
    RunnerClientError::Request(format!("{path} response could not be read: {message}"))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderAuthMaterial {
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    pub provider: String,
    #[serde(rename = "authChoice")]
    pub auth_choice: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpContext {
    pub prompt: String,
    pub messages: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpState {
    pub schema_version: u32,
    pub provider: String,
    pub model: String,
    pub auth_snapshot_id: String,
    pub messages: Vec<serde_json::Value>,
    #[serde(default)]
    pub replayable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<serde_json::Value>,
}

#[async_trait]
pub trait CloudAgentRunClient {
    /// A person's agent opening or updating a plan or vote card (issue #2446).
    async fn plan_card(
        &self,
        _run_id: &str,
        _call_id: &str,
        _action: &str,
        _arguments: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        Err(RunnerClientError::Request(
            "Plan cards are unavailable".into(),
        ))
    }

    async fn agent_exchange(
        &self,
        _run_id: &str,
        _call_id: &str,
        _arguments: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        Err(RunnerClientError::Request(
            "Agent communication is unavailable".into(),
        ))
    }

    async fn task_operator(
        &self,
        _run_id: &str,
        _call_id: &str,
        _arguments: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        Err(RunnerClientError::Request(
            "Subsession tools are unavailable".into(),
        ))
    }

    async fn subsession_progress(
        &self,
        _run_id: &str,
        _call_id: &str,
        _tool_name: &str,
    ) -> Result<(), RunnerClientError> {
        Ok(())
    }
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError>;
    async fn mark_running(&self, run_id: &str) -> Result<(), RunnerClientError>;
    /// Renews the lease and returns whether the requester or owner stopped
    /// the run. The server has already ended a stopped run.
    async fn heartbeat(&self, run_id: &str) -> Result<bool, RunnerClientError> {
        self.mark_running(run_id).await.map(|()| false)
    }
    async fn complete_run(
        &self,
        run_id: &str,
        response_text: &str,
    ) -> Result<(), RunnerClientError>;
    async fn complete_run_with_omp_state(
        &self,
        _run_id: &str,
        _response_text: &str,
        _state: OmpState,
    ) -> Result<(), RunnerClientError> {
        Err(RunnerClientError::Request(
            "OMP state persistence is unavailable".into(),
        ))
    }
    async fn fail_run(
        &self,
        run_id: &str,
        error_code: &str,
        message: &str,
    ) -> Result<(), RunnerClientError>;

    async fn fetch_provider_auth(
        &self,
        run_id: &str,
    ) -> Result<ProviderAuthMaterial, RunnerClientError>;
    async fn fetch_omp_context(
        &self,
        _run_id: &str,
        _provider: &str,
        _model: &str,
        _auth_snapshot_id: &str,
    ) -> Result<OmpContext, RunnerClientError> {
        Err(RunnerClientError::Request(
            "OMP context is unavailable".into(),
        ))
    }

    async fn read_context(
        &self,
        _run_id: &str,
        _tool: &str,
        _arguments: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        Err(RunnerClientError::Request(
            "Conversation retrieval is unavailable".to_string(),
        ))
    }

    /// Forwards one `plan_card` tool call to the server, bound to this run.
    async fn plan_card_action(
        &self,
        _run_id: &str,
        _request: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        Err(RunnerClientError::Request(
            "Plan cards are unavailable".to_string(),
        ))
    }

    async fn export_artifact(
        &self,
        run_id: &str,
        input: ArtifactExportInput,
    ) -> Result<ArtifactExportResponse, RunnerClientError>;

    /// Calls one connector tool on the lease through the server broker.
    async fn call_connector_tool(
        &self,
        _run_id: &str,
        _tool: &kordi_tools::connector_tools::ConnectorToolDescriptor,
        _args: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        Err(RunnerClientError::Request(
            "Connector tools are unavailable".into(),
        ))
    }

    /// Reads the run owner's account memories and memory settings (#1710).
    async fn fetch_memory(&self, _run_id: &str) -> Result<RunnerMemoryContext, MemoryRequestError> {
        Err(MemoryRequestError::Unavailable)
    }

    async fn save_memory(
        &self,
        _run_id: &str,
        _memory: NewRunnerMemory,
    ) -> Result<RunnerMemory, MemoryRequestError> {
        Err(MemoryRequestError::Unavailable)
    }
}

#[derive(Clone)]
pub struct HttpCloudAgentRunClient {
    pub(crate) base_url: String,
    pub(crate) runner_token: String,
    pub(crate) runner_id: String,
    canary_run_id: Option<String>,
    pub(crate) http: reqwest::Client,
}

impl HttpCloudAgentRunClient {
    pub fn for_execution(&self) -> Self {
        Self {
            runner_id: format!("{}:{}", self.runner_id, uuid::Uuid::new_v4().simple()),
            ..self.clone()
        }
    }
    pub fn new(base_url: String, runner_token: String, runner_id: String) -> Self {
        Self::with_canary_run_id(base_url, runner_token, runner_id, None)
    }

    pub fn with_canary_run_id(
        base_url: String,
        runner_token: String,
        runner_id: String,
        canary_run_id: Option<String>,
    ) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            runner_token,
            runner_id,
            canary_run_id: canary_run_id.and_then(|value| {
                let trimmed = value.trim().to_string();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            }),
            http: reqwest::Client::new(),
        }
    }

    fn lease_request_body(&self) -> serde_json::Value {
        match &self.canary_run_id {
            Some(canary_run_id) => serde_json::json!({
                "runnerId": self.runner_id,
                "canaryRunId": canary_run_id,
            }),
            None => serde_json::json!({ "runnerId": self.runner_id }),
        }
    }

    async fn post_json<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<T, RunnerClientError> {
        let response = self
            .http
            .post(format!("{}{}", self.base_url, path))
            .bearer_auth(&self.runner_token)
            .json(&body)
            .send()
            .await
            .map_err(|err| RunnerClientError::Request(err.to_string()))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|err| RunnerClientError::Request(err.to_string()))?;
        if !status.is_success() {
            // Server error bodies are short codes; anything longer is cut.
            let text: String = text.chars().take(300).collect();
            return Err(RunnerClientError::Request(format!(
                "{path} returned {status}: {text}"
            )));
        }
        parse_response(path, &text)
    }
}

/// Reads a successful response body.
fn parse_response<T: for<'de> Deserialize<'de>>(
    path: &str,
    text: &str,
) -> Result<T, RunnerClientError> {
    serde_json::from_str(text).map_err(|err| {
        let failure = parse_failure(path, &err);
        // A lease the runner cannot read still leased its run: name the run
        // so the failure can be traced to it.
        let run_id = serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|value| value.pointer("/run/runId")?.as_str().map(str::to_string));
        match run_id {
            Some(run_id) => failure.for_run(&run_id),
            None => failure,
        }
    })
}

#[async_trait]
impl CloudAgentRunClient for HttpCloudAgentRunClient {
    async fn plan_card(
        &self,
        run_id: &str,
        call_id: &str,
        action: &str,
        arguments: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        self.post_json(
            &format!("/v1/cloud/agent-runs/{run_id}/agent-plan-card"),
            serde_json::json!({"runnerId": self.runner_id, "toolCallId": call_id, "action": action, "arguments": arguments}),
        )
        .await
    }

    async fn agent_exchange(
        &self,
        run_id: &str,
        call_id: &str,
        arguments: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        self.post_json(&format!("/v1/cloud/agent-runs/{run_id}/agent-exchange"),serde_json::json!({"runnerId":self.runner_id,"toolCallId":call_id,"action":"send","arguments":arguments})).await
    }

    async fn task_operator(
        &self,
        run_id: &str,
        call_id: &str,
        arguments: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        self.post_json(&format!("/v1/cloud/agent-runs/{run_id}/task-operator"), serde_json::json!({"runnerId":self.runner_id,"toolCallId":call_id,"arguments":arguments})).await
    }

    async fn subsession_progress(
        &self,
        run_id: &str,
        call_id: &str,
        tool_name: &str,
    ) -> Result<(), RunnerClientError> {
        let _: serde_json::Value = self.post_json(&format!("/v1/cloud/agent-runs/{run_id}/subsession-progress"), serde_json::json!({"runnerId":self.runner_id,"toolCallId":call_id,"toolName":tool_name})).await?;
        Ok(())
    }
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError> {
        let response: LeaseResponse = self
            .post_json("/v1/cloud/agent-runs/lease", self.lease_request_body())
            .await?;
        Ok(response.run)
    }

    async fn mark_running(&self, run_id: &str) -> Result<(), RunnerClientError> {
        let envelope: RunEnvelope = self
            .post_json(
                &format!("/v1/cloud/agent-runs/{run_id}/running"),
                serde_json::json!({ "runnerId": self.runner_id }),
            )
            .await?;
        let _ = envelope.run;
        Ok(())
    }

    async fn heartbeat(&self, run_id: &str) -> Result<bool, RunnerClientError> {
        let envelope: HeartbeatEnvelope = self
            .post_json(
                &format!("/v1/cloud/agent-runs/{run_id}/running"),
                serde_json::json!({ "runnerId": self.runner_id }),
            )
            .await?;
        Ok(envelope.run.cancel_requested)
    }

    async fn complete_run(
        &self,
        run_id: &str,
        response_text: &str,
    ) -> Result<(), RunnerClientError> {
        let envelope: RunEnvelope = self
            .post_json(
                &format!("/v1/cloud/agent-runs/{run_id}/complete"),
                serde_json::json!({ "runnerId": self.runner_id, "responseText": response_text }),
            )
            .await?;
        let _ = envelope.run;
        Ok(())
    }

    async fn complete_run_with_omp_state(
        &self,
        run_id: &str,
        response_text: &str,
        state: OmpState,
    ) -> Result<(), RunnerClientError> {
        let envelope: RunEnvelope = self.post_json(
            &format!("/v1/cloud/agent-runs/{run_id}/complete"),
            serde_json::json!({ "runnerId": self.runner_id, "responseText": response_text, "ompState": state }),
        ).await?;
        let _ = envelope.run;
        Ok(())
    }

    async fn fail_run(
        &self,
        run_id: &str,
        error_code: &str,
        message: &str,
    ) -> Result<(), RunnerClientError> {
        let envelope: RunEnvelope = self
            .post_json(
                &format!("/v1/cloud/agent-runs/{run_id}/fail"),
                serde_json::json!({
                    "runnerId": self.runner_id,
                    "errorCode": error_code,
                    "message": message,
                }),
            )
            .await?;
        let _ = envelope.run;
        Ok(())
    }

    async fn fetch_provider_auth(
        &self,
        run_id: &str,
    ) -> Result<ProviderAuthMaterial, RunnerClientError> {
        let envelope: ProviderAuthEnvelope = self
            .post_json(
                &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
                serde_json::json!({ "runnerId": self.runner_id }),
            )
            .await?;
        Ok(envelope.provider_auth)
    }

    async fn fetch_omp_context(
        &self,
        run_id: &str,
        provider: &str,
        model: &str,
        auth_snapshot_id: &str,
    ) -> Result<OmpContext, RunnerClientError> {
        self.post_json(
            &format!("/v1/cloud/agent-runs/{run_id}/omp-context"),
            serde_json::json!({ "runnerId": self.runner_id, "provider": provider, "model": model, "authSnapshotId": auth_snapshot_id }),
        ).await
    }

    async fn read_context(
        &self,
        run_id: &str,
        tool: &str,
        arguments: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        self.post_json(
            &format!("/v1/cloud/agent-runs/{run_id}/context"),
            serde_json::json!({ "runnerId": self.runner_id, "tool": tool, "arguments": arguments }),
        )
        .await
    }

    async fn plan_card_action(
        &self,
        run_id: &str,
        request: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        self.post_json(
            &format!("/v1/cloud/agent-runs/{run_id}/plan-card"),
            serde_json::json!({ "runnerId": self.runner_id, "request": request }),
        )
        .await
    }

    async fn call_connector_tool(
        &self,
        run_id: &str,
        tool: &kordi_tools::connector_tools::ConnectorToolDescriptor,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        let body = crate::connectors::broker_call_body(&self.runner_id, run_id, tool, args);
        crate::connectors::post_broker_call(&self.http, &self.base_url, &self.runner_token, body)
            .await
    }

    async fn export_artifact(
        &self,
        run_id: &str,
        mut input: ArtifactExportInput,
    ) -> Result<ArtifactExportResponse, RunnerClientError> {
        input.runner_id = self.runner_id.clone();
        let body = serde_json::to_value(input)
            .map_err(|err| RunnerClientError::Request(err.to_string()))?;
        let envelope: ArtifactExportEnvelope = self
            .post_json(&format!("/v1/cloud/agent-runs/{run_id}/artifacts"), body)
            .await?;
        Ok(envelope.artifact)
    }

    async fn fetch_memory(&self, run_id: &str) -> Result<RunnerMemoryContext, MemoryRequestError> {
        crate::memory::http_fetch_memory(self, run_id).await
    }

    async fn save_memory(
        &self,
        run_id: &str,
        memory: NewRunnerMemory,
    ) -> Result<RunnerMemory, MemoryRequestError> {
        crate::memory::http_save_memory(self, run_id, memory).await
    }
}

#[cfg(test)]
#[path = "client_parse_tests.rs"]
mod parse_tests;
