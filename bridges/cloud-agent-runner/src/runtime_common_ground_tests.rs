use super::tests::{leased_run, legacy_fixture_run, temp_sandbox, FakeClient};
use super::*;
use crate::model_loop::{
    CloudModelProvider, ModelLoopError, ModelProviderResponse, OpenAiProviderConfig,
};
use async_trait::async_trait;
use serde_json::Value;

struct CardProvider(&'static str);

#[async_trait]
impl CloudModelProvider for CardProvider {
    async fn next_response(
        &self,
        _: &OpenAiProviderConfig,
        messages: &[Value],
        tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        assert!(tools.is_empty(), "card builds get no tools");
        assert_eq!(messages[0]["content"], "Card instructions");
        assert_eq!(messages[1]["content"], "Evidence");
        Ok(ModelProviderResponse::FinalText(self.0.into()))
    }
}

fn card_run(run_id: &str) -> CloudAgentRun {
    CloudAgentRun {
        prompt: "Evidence".into(),
        system_prompt: "Card instructions".into(),
        sandbox_id: None,
        ..leased_run(run_id, true)
    }
}

#[tokio::test]
async fn common_ground_runs_complete_without_a_sandbox_or_tools() {
    let client = FakeClient::with_run(card_run("cg_card_fixture"));
    let root = temp_sandbox();
    let outcome = legacy_fixture_run(&client, &CardProvider("{\"working_on\":[]}"), root.clone())
        .await
        .unwrap();
    assert_eq!(
        outcome,
        RunnerStepOutcome::Completed {
            run_id: "cg_card_fixture".into()
        }
    );
    assert!(!root.exists());
    assert_eq!(
        client.calls(),
        vec![
            "lease",
            "running:cg_card_fixture",
            "provider-auth:cg_card_fixture",
            "complete:cg_card_fixture:{\"working_on\":[]}"
        ]
    );
}

#[tokio::test]
async fn an_empty_reply_fails_the_run() {
    let client = FakeClient::with_run(card_run("cg_card_empty"));
    let outcome = legacy_fixture_run(&client, &CardProvider("  "), temp_sandbox())
        .await
        .unwrap();
    assert_eq!(
        outcome,
        RunnerStepOutcome::FailedProviderError {
            run_id: "cg_card_empty".into()
        }
    );
    assert!(client
        .calls()
        .contains(&"fail:cg_card_empty:common_ground_run_failed".to_string()));
}

#[test]
fn omp_common_ground_runs_send_medium_effort_for_a_default_route() {
    use crate::common_ground::omp_thinking;
    assert_eq!(omp_thinking("default"), "medium");
    assert_eq!(omp_thinking("low"), "low");
    assert_eq!(omp_thinking("high"), "high");
}

/// A client whose server rejects the finished reply.
struct RejectingComplete(FakeClient);

#[async_trait]
impl CloudAgentRunClient for RejectingComplete {
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError> {
        self.0.lease_next_run().await
    }
    async fn mark_running(&self, run_id: &str) -> Result<(), RunnerClientError> {
        self.0.mark_running(run_id).await
    }
    async fn complete_run(&self, run_id: &str, _: &str) -> Result<(), RunnerClientError> {
        Err(RunnerClientError::Request(format!(
            "/v1/cloud/agent-runs/{run_id}/complete returned 404 Not Found: {{\"errorCode\":\"agent_run_not_found\"}}"
        )))
    }
    async fn fail_run(
        &self,
        run_id: &str,
        code: &str,
        message: &str,
    ) -> Result<(), RunnerClientError> {
        self.0.fail_run(run_id, code, message).await
    }
    async fn fetch_provider_auth(
        &self,
        run_id: &str,
    ) -> Result<crate::client::ProviderAuthMaterial, RunnerClientError> {
        self.0.fetch_provider_auth(run_id).await
    }
    async fn export_artifact(
        &self,
        run_id: &str,
        input: crate::client::ArtifactExportInput,
    ) -> Result<crate::client::ArtifactExportResponse, RunnerClientError> {
        self.0.export_artifact(run_id, input).await
    }
}

#[tokio::test]
async fn a_failed_step_reports_its_run_and_cause() {
    let client = RejectingComplete(FakeClient::with_run(card_run("cg_card_rejected")));
    let error = legacy_fixture_run(
        &client,
        &CardProvider("{\"working_on\":[]}"),
        temp_sandbox(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.run_id(), Some("cg_card_rejected"));
    let chain = error.chain();
    assert!(chain.contains("returned 404 Not Found"), "{chain}");
    assert!(!chain.contains("Evidence"), "{chain}");
}
