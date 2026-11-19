//! The code a failed run carries is the only reason another member's client
//! can show, so the classification of the runtime's fixed wording is pinned.

use kordi_omp_runtime::RuntimeError;

use super::tests::{leased_run, FakeClient};
use super::*;
use crate::model_loop::ModelLoopError;

fn code_for(worker_code: &str) -> &'static str {
    model_failure_code(&RuntimeError::Worker(worker_code.into()).to_string())
}

/// The message a model-loop failure carries, as `fail_run` records it.
fn loop_code(error: &ModelLoopError) -> &'static str {
    model_failure_code(&error.to_string())
}

#[test]
fn rejected_sign_ins_are_reported_as_reconnectable() {
    let code = model_failure_code;
    assert_eq!(
        code("provider error: The provider sign-in needs attention. Reconnect this account."),
        "provider_auth_rejected"
    );
    assert_eq!(
        code("provider error: 401 Unauthorized"),
        "provider_auth_rejected"
    );
    assert_eq!(
        code("provider error: The provider is busy or rate-limited."),
        "model_provider_error"
    );
    assert_eq!(code_for("provider_http_401"), "provider_auth_rejected");
    assert_eq!(
        code_for("provider_account_identity"),
        "provider_auth_rejected"
    );
}

#[test]
fn refused_models_are_reported_as_unavailable() {
    let code = model_failure_code;
    assert_eq!(
        code(
            "provider error: The selected model is unavailable for this account. Choose another model."
        ),
        "model_unavailable"
    );
    assert_eq!(
        code("provider error: 400 {\"code\":\"model_not_found\"}"),
        "model_unavailable"
    );
    assert_eq!(code_for("provider_model_unavailable"), "model_unavailable");
    assert_eq!(code_for("model_unavailable"), "model_unavailable");
}

#[test]
fn transient_provider_failures_are_reported_as_a_model_service_error() {
    for worker_code in [
        "provider_http_429",
        "provider_http_500",
        "provider_http_503",
        "provider_http_5xx",
        "provider_tls",
        "provider_connection",
        "provider_http_400",
        "provider_http_403",
        "provider_tool_schema",
        "provider_unsupported_parameter",
        "provider_something_new",
    ] {
        assert_eq!(
            code_for(worker_code),
            "model_provider_error",
            "{worker_code}"
        );
    }
    // The wording the loop records wraps the provider failure.
    let wrapped =
        ModelLoopError::Provider(RuntimeError::Worker("provider_http_429".into()).to_string());
    assert_eq!(loop_code(&wrapped), "model_provider_error");
}

#[test]
fn other_runtime_failures_also_read_as_a_model_service_error() {
    // Today these fall through to the model-service code; a member reads
    // "the model service did not respond" for them.
    for worker_code in ["timeout", "step_limit", "hook_error", "worker_error"] {
        assert_eq!(
            code_for(worker_code),
            "model_provider_error",
            "{worker_code}"
        );
    }
}

#[tokio::test]
async fn a_saved_account_that_needs_reconnecting_fails_with_the_rejected_code() {
    let mut run = leased_run("car_reconnect", false);
    run.provider_auth_needs_reconnect = true;
    let client = FakeClient::with_run(run);

    let outcome = process_one_run(&client).await.unwrap();

    assert_eq!(
        outcome,
        RunnerStepOutcome::FailedMissingProviderAuth {
            run_id: "car_reconnect".to_string()
        }
    );
    assert_eq!(
        client.calls(),
        vec!["lease", "fail:car_reconnect:provider_auth_rejected"]
    );
}
