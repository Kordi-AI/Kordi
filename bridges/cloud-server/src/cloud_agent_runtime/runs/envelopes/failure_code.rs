//! The failure category a failed agent reply carries.
//!
//! Every member of a chat receives the same failed reply. Its text is always a
//! neutral line ("<Agent> couldn't reply."), which older clients show as is.
//! The stable `failureCode` is the only thing that tells a client why:
//!
//! - The agent owner's devices turn the code into the detailed reason.
//! - Every other member's client shows one fixed short line per code, never
//!   provider text, URLs, model names, account or snapshot ids, or the run's
//!   `error_message`.
//!
//! The wording lives in the clients, so Mac, iPhone and web agree. The codes
//! the server puts on a failed reply, and what a member reads for each:
//!
//! | `failureCode`            | member reads                                  |
//! | ------------------------ | --------------------------------------------- |
//! | `missing_provider_auth`  | the owner has not connected a model yet       |
//! | `provider_auth_rejected` | the owner needs to reconnect their model      |
//! | `model_unavailable`      | the owner needs to choose another model       |
//! | `model_provider_error`   | the model service did not respond, try again  |
//! | `sandbox_error`, `failed`, anything else | "<Agent> couldn't reply."     |
//!
//! `agent_unreachable` and `agent_not_available` are sent by the refused and
//! unreachable request paths (`project_unavailable`), not through this module.
//! The list is closed: a new code needs a matching line in every client.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

use super::{CLOUD_AGENT_RESPONSE_PREFIX, CLOUD_GROUP_PREFIX};

/// Every code [`cloud_agent_failure_code`] can return.
#[cfg(test)]
const FAILURE_CODES: [&str; 5] = [
    "missing_provider_auth",
    "provider_auth_rejected",
    "model_unavailable",
    "model_provider_error",
    "sandbox_error",
];

/// The stable code a client renders for a run error code. Each run error code
/// that can fail a person's request is listed; anything else is `failed`.
pub(in crate::cloud_agent_runtime::runs) fn cloud_agent_failure_code(
    error_code: &str,
) -> &'static str {
    match error_code {
        // The owner has no usable provider account.
        "missing_provider_auth" | "provider_auth_not_configured" => "missing_provider_auth",
        // The saved account was rejected or expired.
        "provider_auth_rejected" | "credential_expired" => "provider_auth_rejected",
        "model_unavailable" => "model_unavailable",
        "model_provider_error" => "model_provider_error",
        "sandbox_error" | "sandbox_backend_error" | "missing_sandbox" => "sandbox_error",
        // Known codes with no reason a member can act on.
        "tool_error" | "run_attempts_exhausted" | "pool_worker_run_failed" | "failed" => "failed",
        _ => "failed",
    }
}

/// The neutral line every member reads when the agent could not reply.
pub(in crate::cloud_agent_runtime::runs) fn cloud_agent_shared_failure_text(
    agent_name: Option<&str>,
) -> String {
    match agent_name.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => format!("{name} couldn't reply."),
        None => "The agent couldn't reply.".to_string(),
    }
}

/// Adds `failureCode` to an agent reply or to the message of a group reply.
/// A body of any other shape is returned unchanged.
pub(in crate::cloud_agent_runtime::runs) fn with_failure_code(
    body: &str,
    failure_code: &str,
) -> String {
    let trimmed = body.trim();
    let (prefix, in_message) = if trimmed.starts_with(CLOUD_AGENT_RESPONSE_PREFIX) {
        (CLOUD_AGENT_RESPONSE_PREFIX, false)
    } else if trimmed.starts_with(CLOUD_GROUP_PREFIX) {
        (CLOUD_GROUP_PREFIX, true)
    } else {
        return body.to_string();
    };
    let Some(mut value) = URL_SAFE_NO_PAD
        .decode(&trimmed[prefix.len()..])
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
    else {
        return body.to_string();
    };
    let target = if in_message {
        &mut value["message"]
    } else {
        &mut value
    };
    let Some(object) = target.as_object_mut() else {
        return body.to_string();
    };
    object.insert(
        "failureCode".to_string(),
        serde_json::Value::String(failure_code.to_string()),
    );
    format!("{prefix}{}", URL_SAFE_NO_PAD.encode(value.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decoded(body: &str, prefix: &str) -> serde_json::Value {
        let bytes = URL_SAFE_NO_PAD.decode(&body[prefix.len()..]).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn run_error_codes_map_to_the_wire_codes() {
        for (run_code, wire) in [
            ("missing_provider_auth", "missing_provider_auth"),
            ("provider_auth_not_configured", "missing_provider_auth"),
            ("provider_auth_rejected", "provider_auth_rejected"),
            ("credential_expired", "provider_auth_rejected"),
            ("model_unavailable", "model_unavailable"),
            ("model_provider_error", "model_provider_error"),
            ("sandbox_error", "sandbox_error"),
            ("sandbox_backend_error", "sandbox_error"),
            ("missing_sandbox", "sandbox_error"),
            ("tool_error", "failed"),
            ("run_attempts_exhausted", "failed"),
            ("pool_worker_run_failed", "failed"),
            ("runner_crashed", "failed"),
            ("agent_unreachable", "failed"),
            ("", "failed"),
            (" ", "failed"),
            ("MODEL_UNAVAILABLE", "failed"),
        ] {
            assert_eq!(cloud_agent_failure_code(run_code), wire, "{run_code:?}");
        }
    }

    #[test]
    fn every_returned_code_is_in_the_closed_list() {
        // A client has one line per code, so the mapping may only return these.
        for run_code in [
            "missing_provider_auth",
            "provider_auth_not_configured",
            "provider_auth_rejected",
            "credential_expired",
            "model_unavailable",
            "model_provider_error",
            "sandbox_error",
            "sandbox_backend_error",
            "missing_sandbox",
            "tool_error",
            "run_attempts_exhausted",
            "pool_worker_run_failed",
            "agent_not_available",
            "anything_else",
            "",
        ] {
            let wire = cloud_agent_failure_code(run_code);
            assert!(
                wire == "failed" || FAILURE_CODES.contains(&wire),
                "{run_code:?} -> {wire}"
            );
        }
        for code in FAILURE_CODES {
            assert_eq!(cloud_agent_failure_code(code), code);
        }
    }

    #[test]
    fn the_shared_line_names_only_the_agent() {
        assert_eq!(
            cloud_agent_shared_failure_text(Some(" Pebble ")),
            "Pebble couldn't reply."
        );
        assert_eq!(
            cloud_agent_shared_failure_text(Some("  ")),
            "The agent couldn't reply."
        );
        assert_eq!(
            cloud_agent_shared_failure_text(None),
            "The agent couldn't reply."
        );
    }

    #[test]
    fn the_code_rides_an_agent_reply_and_a_group_message() {
        let reply = format!(
            "{CLOUD_AGENT_RESPONSE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(r#"{"kind":"agent-response","requestId":"r1","text":"x"}"#)
        );
        let reply = with_failure_code(&reply, "provider_auth_rejected");
        assert_eq!(
            decoded(&reply, CLOUD_AGENT_RESPONSE_PREFIX)["failureCode"],
            "provider_auth_rejected"
        );

        let group = format!(
            "{CLOUD_GROUP_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(r#"{"kind":"group-message","message":{"id":"m1","text":"x"}}"#)
        );
        let group = with_failure_code(&group, "failed");
        let value = decoded(&group, CLOUD_GROUP_PREFIX);
        assert_eq!(value["message"]["failureCode"], "failed");
        assert!(value.get("failureCode").is_none());

        assert_eq!(with_failure_code("plain text", "failed"), "plain text");
    }
}
