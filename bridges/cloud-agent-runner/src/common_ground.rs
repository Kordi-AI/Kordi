//! Common ground runs (card builds, matching, room themes): one completion
//! with no tools and no sandbox.
//! The prompt holds redacted evidence or shared cards; the server parses the reply.

use std::time::Duration;

use kordi_omp_runtime::RuntimeError;
use serde_json::json;
use tokio::time::Instant;

use crate::client::{CloudAgentRun, CloudAgentRunClient, ProviderAuthMaterial, RunnerClientError};
use crate::model_loop::{
    CloudModelProvider, ModelLoopError, ModelProviderResponse, OpenAiProviderConfig,
    ProviderRetryPolicy,
};
use crate::runtime::{CloudModelEngine, RunnerStepOutcome};

pub const RUN_PREFIX: &str = "cg_";
const MATCH_RUN_PREFIX: &str = "cg_match_";
/// Leaves room to wait out a few provider rate limits; the heartbeat keeps
/// the lease alive meanwhile.
const TIMEOUT_SECONDS: u64 = 300;
/// OMP attempts end this long before the step's own timeout.
const OMP_TIMEOUT_MARGIN: Duration = Duration::from_secs(10);
/// OMP surfaces a rate limit only after its own short retries, so a busy
/// gateway (Retry-After of about 30 s) needs a few longer waits here.
const RATE_LIMIT_RETRIES: u32 = 3;
const MAX_RATE_LIMIT_WAIT: Duration = Duration::from_secs(60);
/// The first wait when the provider names no delay; it doubles each retry.
const DEFAULT_RATE_LIMIT_WAIT: Duration = Duration::from_secs(15);
/// A retry is skipped when less than this would be left for the attempt.
const MIN_ATTEMPT_TIME: Duration = Duration::from_secs(30);
/// Matching compares short shared cards, and a large room sends them in big
/// batches, so a route's "default" thinking runs at low effort there.
const MATCH_DEFAULT_THINKING: &str = "low";
/// OMP sends a route's "default" thinking as high effort. On a large matching
/// batch, gpt-5-mini then reasons past the time limit before writing any reply.
/// Medium is what the provider uses when no effort is sent (the Rust engine).
const OMP_DEFAULT_THINKING: &str = "medium";

/// The reasoning effort an OMP Common ground run sends for a route's thinking.
pub(crate) fn omp_thinking(thinking: &str) -> &str {
    if thinking == "default" {
        OMP_DEFAULT_THINKING
    } else {
        thinking
    }
}

/// The effort a match run sends in place of a route's "default" thinking.
/// Card builds and room themes keep the engine's effort (`None`).
pub(crate) fn match_thinking(run_id: &str, requested: &str) -> Option<&'static str> {
    (requested == "default" && run_id.starts_with(MATCH_RUN_PREFIX))
        .then_some(MATCH_DEFAULT_THINKING)
}

/// The run's provider settings: its route, background retries, and the
/// effort for its kind of run.
pub(crate) fn run_auth(
    material: &ProviderAuthMaterial,
    run: &CloudAgentRun,
    engine: CloudModelEngine,
) -> Result<OpenAiProviderConfig, ModelLoopError> {
    let mut auth = OpenAiProviderConfig::from_material(material)?;
    // The route's thinking wins over the snapshot's, as in `apply_runtime_route`.
    let requested = run
        .runtime_route
        .thinking
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&auth.thinking)
        .to_string();
    auth.apply_runtime_route(&run.runtime_route, &material.provider)?;
    auth.retry = ProviderRetryPolicy::BACKGROUND;
    if engine == CloudModelEngine::Omp {
        auth.thinking = omp_thinking(&auth.thinking).to_string();
    }
    if let Some(thinking) = match_thinking(&run.run_id, &requested) {
        auth.thinking = thinking.to_string();
    }
    Ok(auth)
}

/// Runs `attempt` with the time left before `deadline`, and retries a
/// provider rate limit after the delay the provider names or a growing default.
pub(crate) async fn retry_rate_limits<T, F, Fut>(
    deadline: Instant,
    mut attempt: F,
) -> Result<T, RuntimeError>
where
    F: FnMut(Duration) -> Fut,
    Fut: std::future::Future<Output = Result<T, RuntimeError>>,
{
    let mut retries = 0;
    loop {
        let error = match attempt(deadline.saturating_duration_since(Instant::now())).await {
            Ok(value) => return Ok(value),
            Err(error) => error,
        };
        let Some(wait) = rate_limit_wait(&error, retries) else {
            return Err(error);
        };
        let left = deadline.saturating_duration_since(Instant::now());
        if retries >= RATE_LIMIT_RETRIES || left < wait + MIN_ATTEMPT_TIME {
            return Err(error);
        }
        retries += 1;
        tracing::info!(
            retries,
            wait_secs = wait.as_secs(),
            "common ground run rate-limited"
        );
        tokio::time::sleep(wait).await;
    }
}

/// The wait before retrying an OMP failure, or `None` when it is not a rate limit.
fn rate_limit_wait(error: &RuntimeError, retries: u32) -> Option<Duration> {
    let reason = match error {
        RuntimeError::Provider { reason, .. } => reason.to_ascii_lowercase(),
        _ => String::new(),
    };
    let rate_limited = error.diagnostic_code() == "provider_http_429"
        || ["rate limit", "rate-limit", "too many requests"]
            .iter()
            .any(|wording| reason.contains(wording));
    if !rate_limited {
        return None;
    }
    let wait = named_delay(&reason)
        .unwrap_or_else(|| DEFAULT_RATE_LIMIT_WAIT.saturating_mul(2u32.saturating_pow(retries)));
    Some(wait.min(MAX_RATE_LIMIT_WAIT))
}

/// A delay the provider names in its reason, such as "Please try again in
/// 20s" or "retry after 30 seconds".
fn named_delay(reason: &str) -> Option<Duration> {
    let rest = ["try again in ", "retry after ", "retry-after: "]
        .iter()
        .find_map(|marker| reason.find(marker).map(|at| &reason[at + marker.len()..]))?;
    let digits = rest
        .find(|ch: char| !ch.is_ascii_digit() && ch != '.')
        .unwrap_or(rest.len());
    let value = rest[..digits].parse::<f64>().ok()?;
    let millis = if rest[digits..].starts_with("ms") {
        value
    } else {
        value * 1000.0
    };
    millis
        .is_finite()
        .then(|| Duration::from_millis(millis.max(0.0) as u64))
}

pub(crate) struct NoTools;

#[async_trait::async_trait]
impl kordi_omp_runtime::HostTool for NoTools {
    async fn execute(
        &self,
        _: kordi_omp_runtime::ToolCall,
        _: tokio_util::sync::CancellationToken,
    ) -> kordi_omp_runtime::ToolResult {
        crate::omp_job::tool_result(json!({ "error": "No tools are available." }))
    }
}

/// One Common ground completion with the engine's model, for `step` and for
/// offline quality checks of card builds.
pub async fn generate<C, P>(
    client: &C,
    provider: &P,
    engine: CloudModelEngine,
    run: &CloudAgentRun,
) -> Result<String, String>
where
    C: CloudAgentRunClient + Sync,
    P: CloudModelProvider + Sync,
{
    let material = client
        .fetch_provider_auth(&run.run_id)
        .await
        .map_err(|error| error.to_string())?;
    let auth = run_auth(&material, run, engine).map_err(|error| error.to_string())?;
    let text = match engine {
        CloudModelEngine::Omp => {
            let deadline =
                Instant::now() + Duration::from_secs(TIMEOUT_SECONDS) - OMP_TIMEOUT_MARGIN;
            let result = retry_rate_limits(deadline, |left| {
                let job = crate::omp_job::Job {
                    run,
                    auth: &auth,
                    prompt: run.prompt.clone(),
                    messages: vec![],
                    resume: false,
                    tools: vec![],
                    timeout_ms: u64::try_from(left.as_millis()).unwrap_or(u64::MAX).max(1),
                    model_step_limit: None,
                    tool_call_limit: None,
                };
                async move { crate::omp_job::run(job, &NoTools, &|_| async { Ok(()) }).await }
            })
            .await
            .map_err(|error| error.to_string())?;
            // One turn with no tools: the last reply's usage is the run's.
            if let Some(usage) = &result.usage {
                crate::usage_meter::record_omp_message(
                    &json!({"role": "assistant", "usage": usage}),
                );
            }
            result.text
        }
        CloudModelEngine::Rust => {
            let messages = [
                json!({ "role": "system", "content": run.system_prompt }),
                json!({ "role": "user", "content": run.prompt }),
            ];
            match provider.next_response(&auth, &messages, &[]).await {
                Ok(ModelProviderResponse::FinalText(text)) => text,
                Ok(ModelProviderResponse::ToolCalls(_)) => {
                    return Err("unexpected tool call".into());
                }
                Err(error) => return Err(error.to_string()),
            }
        }
    };
    if text.trim().is_empty() {
        return Err("the model finished without a reply".into());
    }
    Ok(text)
}

/// Runs one Common ground run, keeping its lease alive while the model works.
pub(crate) async fn step<C, P>(
    client: &C,
    provider: &P,
    engine: CloudModelEngine,
    run: CloudAgentRun,
) -> Result<RunnerStepOutcome, RunnerClientError>
where
    C: CloudAgentRunClient + Sync,
    P: CloudModelProvider + Sync,
{
    let run_id = run.run_id.clone();
    let generation = generate(client, provider, engine, &run);
    tokio::pin!(generation);
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(40));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    heartbeat.tick().await;
    let response = tokio::time::timeout(std::time::Duration::from_secs(TIMEOUT_SECONDS), async {
        loop {
            tokio::select! {
                result = &mut generation => break Ok::<_, RunnerClientError>(result),
                _ = heartbeat.tick() => client.mark_running(&run.run_id).await?,
            }
        }
    })
    .await
    .unwrap_or(Ok(Err("timed out".into())))?;
    match response {
        Ok(text) => {
            client.complete_run(&run.run_id, &text).await?;
            Ok(RunnerStepOutcome::Completed { run_id })
        }
        Err(detail) => {
            // The detail can quote provider errors, so only its length is logged.
            tracing::warn!(run_id = %run.run_id, detail_len = detail.len(), "common ground run failed");
            client
                .fail_run(
                    &run.run_id,
                    "common_ground_run_failed",
                    "Common ground run failed.",
                )
                .await?;
            Ok(RunnerStepOutcome::FailedProviderError { run_id })
        }
    }
}
