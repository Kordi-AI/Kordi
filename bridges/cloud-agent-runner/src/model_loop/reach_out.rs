//! The `reach_out` tool on the cloud runner. A refusal's error code and
//! message go back to the model, as on the Mac, so it can correct the call
//! (for example, ask the person who asked in its reply) and the failure is
//! diagnosable; it is still told never to claim the request was sent.

use serde_json::Value;

/// The tool error for a failed `agent-exchange` call. A server error keeps
/// no detail, since its message is not meant for the model.
pub(super) fn failure(error: &str) -> String {
    let body = error
        .find('{')
        .and_then(|start| serde_json::from_str::<Value>(&error[start..]).ok())
        .filter(|_| !error.contains(" returned 5"));
    match body {
        Some(body) => {
            kordi_tools::reach_out::not_sent(body["errorCode"].as_str(), body["message"].as_str())
        }
        None => "The agent request was not confirmed. Do not claim it was sent.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::failure;

    #[test]
    fn a_refusal_keeps_the_server_reason_and_a_failure_does_not() {
        let refused = failure(
            r#"/v1/cloud/agent-runs/r/agent-exchange returned 422 Unprocessable Entity: {"errorCode":"context_unavailable","message":"The person who asked cannot be asked with reach_out in this conversation."}"#,
        );
        assert!(refused.contains("(context_unavailable): The person who asked cannot be asked"));
        assert!(refused.ends_with("Do not claim that a request was sent."));
        assert_eq!(
            failure(
                r#"/v1/cloud/agent-runs/r/agent-exchange returned 500 Internal Server Error: {"message":"db"}"#
            ),
            "The agent request was not confirmed. Do not claim it was sent."
        );
        assert!(failure("connection refused").contains("Do not claim"));
    }
}
