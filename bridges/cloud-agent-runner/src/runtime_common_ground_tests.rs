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

mod retry_and_effort {
    use crate::client::{AgentRuntimeRoute, CloudAgentRun, ProviderAuthMaterial};
    use crate::common_ground::{match_thinking, retry_rate_limits, run_auth};
    use crate::model_loop::{OpenAiProviderConfig, ProviderRetryPolicy};
    use crate::runtime::CloudModelEngine;
    use kordi_omp_runtime::RuntimeError;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;
    use tokio::time::Instant;

    fn material() -> ProviderAuthMaterial {
        ProviderAuthMaterial {
            snapshot_id: "snap_fixture".into(),
            provider: "openai".into(),
            auth_choice: "default".into(),
            payload: serde_json::json!({
                "apiKey": "fixture-key",
                "baseUrl": "https://api.openai.com/v1",
                "model": "gpt-4.1-mini"
            }),
        }
    }

    fn run(run_id: &str, thinking: Option<&str>) -> CloudAgentRun {
        CloudAgentRun {
            runtime_route: AgentRuntimeRoute {
                default_model: None,
                thinking: thinking.map(Into::into),
            },
            ..super::card_run(run_id)
        }
    }

    fn thinking(run_id: &str, route: Option<&str>, engine: CloudModelEngine) -> String {
        run_auth(&material(), &run(run_id, route), engine)
            .unwrap()
            .thinking
    }

    #[test]
    fn common_ground_runs_wait_out_rate_limits_and_chat_runs_do_not() {
        let chat = OpenAiProviderConfig::from_material(&material()).unwrap();
        assert_eq!(chat.retry, ProviderRetryPolicy::INTERACTIVE);
        for engine in [CloudModelEngine::Rust, CloudModelEngine::Omp] {
            let auth = run_auth(&material(), &run("cg_card_fixture", None), engine).unwrap();
            assert_eq!(auth.retry, ProviderRetryPolicy::BACKGROUND);
        }
    }

    #[test]
    fn only_match_runs_send_low_effort_for_a_default_route() {
        assert_eq!(match_thinking("cg_match_fixture", "default"), Some("low"));
        assert_eq!(match_thinking("cg_match_fixture", "high"), None);
        assert_eq!(match_thinking("cg_card_fixture", "default"), None);
        assert_eq!(match_thinking("cg_room_fixture", "default"), None);

        use CloudModelEngine::{Omp, Rust};
        assert_eq!(thinking("cg_match_fixture", None, Omp), "low");
        assert_eq!(thinking("cg_match_fixture", Some("default"), Rust), "low");
        assert_eq!(thinking("cg_match_fixture", Some("high"), Omp), "high");
        assert_eq!(thinking("cg_card_fixture", None, Omp), "medium");
        assert_eq!(thinking("cg_card_fixture", None, Rust), "default");
        assert_eq!(thinking("cg_room_fixture", Some("default"), Omp), "medium");
    }

    fn rate_limited() -> RuntimeError {
        RuntimeError::Worker("provider_http_429".into())
    }

    /// Fails with `errors` in order, then succeeds; returns the attempt count
    /// and the paused-clock time spent.
    async fn attempts(
        deadline: Duration,
        errors: Vec<RuntimeError>,
    ) -> (Result<(), String>, u32, Duration) {
        let start = Instant::now();
        let count = AtomicU32::new(0);
        let errors = std::sync::Mutex::new(errors.into_iter());
        let result = retry_rate_limits(start + deadline, |left| {
            count.fetch_add(1, Ordering::SeqCst);
            assert!(left <= deadline);
            let next = errors.lock().unwrap().next();
            async move { next.map_or(Ok(()), Err) }
        })
        .await
        .map_err(|error| error.diagnostic_code().to_string());
        (result, count.into_inner(), start.elapsed())
    }

    #[tokio::test(start_paused = true)]
    async fn a_rate_limit_without_a_delay_backs_off_from_fifteen_seconds() {
        let (result, count, elapsed) = attempts(
            Duration::from_secs(290),
            vec![rate_limited(), rate_limited()],
        )
        .await;
        assert_eq!((result, count), (Ok(()), 3));
        assert_eq!(elapsed, Duration::from_secs(15 + 30));
    }

    #[tokio::test(start_paused = true)]
    async fn a_named_delay_is_honored_up_to_sixty_seconds() {
        let provider = |reason: &str| RuntimeError::Provider {
            code: "provider_http_429".into(),
            reason: reason.into(),
        };
        let (result, count, elapsed) = attempts(
            Duration::from_secs(290),
            vec![
                provider("Rate limit reached. Please try again in 30s."),
                provider("Too many requests, retry after 120 seconds"),
            ],
        )
        .await;
        assert_eq!((result, count), (Ok(()), 3));
        assert_eq!(elapsed, Duration::from_secs(30 + 60));
    }

    #[tokio::test(start_paused = true)]
    async fn other_failures_and_exhausted_retries_fail_without_waiting_longer() {
        let (result, count, elapsed) = attempts(
            Duration::from_secs(290),
            vec![RuntimeError::Worker("provider_http_401".into())],
        )
        .await;
        assert_eq!(
            (result, count, elapsed),
            (Err("provider_http_401".into()), 1, Duration::ZERO)
        );

        let (result, count, _) = attempts(
            Duration::from_secs(290),
            (0..4).map(|_| rate_limited()).collect(),
        )
        .await;
        assert_eq!((result, count), (Err("provider_http_429".into()), 4));

        // 15 s of waiting would leave less than the minimum attempt time.
        let (result, count, elapsed) =
            attempts(Duration::from_secs(40), vec![rate_limited()]).await;
        assert_eq!(
            (result, count, elapsed),
            (Err("provider_http_429".into()), 1, Duration::ZERO)
        );
    }
}
