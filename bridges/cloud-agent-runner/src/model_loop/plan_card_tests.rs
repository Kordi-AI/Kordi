//! `plan_card` on the cloud runner forwards every call of a run the server
//! allows, including the System agent's `propose` vocabulary (issue #2446).
use super::*;
use crate::client::{
    ArtifactExportInput, ArtifactExportResponse, ProviderAuthMaterial, RunnerClientError,
};
use async_trait::async_trait;
use serde_json::json;
use std::sync::Mutex;

#[derive(Default)]
struct Recorder(Mutex<Vec<(String, String)>>);

#[async_trait]
impl CloudAgentRunClient for Recorder {
    async fn plan_card(
        &self,
        run_id: &str,
        _: &str,
        action: &str,
        _: Value,
    ) -> Result<Value, RunnerClientError> {
        self.0
            .lock()
            .unwrap()
            .push((run_id.to_string(), action.to_string()));
        Ok(json!({"eventId": "plan_1", "kind": "vote", "card": {"revision": 1}}))
    }
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError> {
        Ok(None)
    }
    async fn mark_running(&self, _: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }
    async fn complete_run(&self, _: &str, _: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }
    async fn fail_run(&self, _: &str, _: &str, _: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }
    async fn fetch_provider_auth(
        &self,
        _: &str,
    ) -> Result<ProviderAuthMaterial, RunnerClientError> {
        unreachable!()
    }
    async fn export_artifact(
        &self,
        _: &str,
        _: ArtifactExportInput,
    ) -> Result<ArtifactExportResponse, RunnerClientError> {
        unreachable!()
    }
}

/// A resumed exchange run: background, owner = requester, no subsession.
fn resume_run(plan_cards: bool) -> CloudAgentRun {
    serde_json::from_value(json!({
        "runId": "car_exchange_resume_1", "status": "leased", "prompt": "Continue",
        "ownerAccountId": "acct_owner", "requesterAccountId": "acct_owner",
        "sessionId": "session:group:one", "sandboxId": null, "providerAuthAvailable": true,
        "planCards": plan_cards, "trigger": "background",
    }))
    .unwrap()
}

fn tool_call(arguments: Value) -> ModelToolCall {
    ModelToolCall {
        id: "call_1".into(),
        name: "plan_card".into(),
        arguments,
    }
}

#[tokio::test]
async fn a_resumed_run_forwards_create_update_and_propose() {
    let client = Recorder::default();
    let run = resume_run(true);
    for action in ["create", "update", "propose"] {
        let output = call(&client, &run, &tool_call(json!({"action": action})))
            .await
            .expect("forwarded");
        assert!(output.as_str().unwrap().contains("eventId: plan_1"));
    }
    let calls = client.0.lock().unwrap().clone();
    assert_eq!(
        calls
            .iter()
            .map(|(_, action)| action.as_str())
            .collect::<Vec<_>>(),
        ["create", "update", "propose"]
    );
    assert!(calls.iter().all(|(run, _)| run == "car_exchange_resume_1"));
}

#[tokio::test]
async fn a_run_without_the_capability_never_reaches_the_server() {
    let client = Recorder::default();
    let error = call(
        &client,
        &resume_run(false),
        &tool_call(json!({"action": "create"})),
    )
    .await
    .unwrap_err();
    assert!(error.as_str().unwrap().contains("not available"));
    assert!(client.0.lock().unwrap().is_empty());
}
