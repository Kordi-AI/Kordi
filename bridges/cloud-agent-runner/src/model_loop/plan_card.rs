//! The `plan_card` tool on the cloud runner (issue #2446).

use serde_json::Value;

use super::ModelToolCall;
use crate::client::{CloudAgentRun, CloudAgentRunClient};

/// Forwards a `plan_card` call to the server, which binds it to this run's
/// lease and conversation. A rejection's reason goes back to the model so it
/// can correct the call (for example, update the card this task opened).
pub(super) async fn call<C: CloudAgentRunClient + Sync>(
    client: &C,
    run: &CloudAgentRun,
    call: &ModelToolCall,
) -> Result<Value, Value> {
    if !run.plan_cards || run.subsession_id.is_some() {
        return Err("Plan cards are not available for this run.".into());
    }
    // The server checks the action and names the fix for a wrong one.
    let action = call.arguments["action"].as_str().unwrap_or_default().trim();
    match client
        .plan_card(&run.run_id, &call.id, action, call.arguments.clone())
        .await
    {
        Ok(result) => Ok(kordi_tools::plan_card::summary(&result).into()),
        Err(error) => Err(plan_card_failure(&error.to_string()).into()),
    }
}

fn plan_card_failure(error: &str) -> String {
    let reason = error
        .find('{')
        .and_then(|start| serde_json::from_str::<Value>(&error[start..]).ok())
        .and_then(|body| body["message"].as_str().map(str::to_string))
        .filter(|message| !message.is_empty() && !error.contains(" returned 5"));
    match reason {
        Some(reason) => format!("The plan card was not saved: {reason}"),
        None => "The plan card was not saved. Do not claim a card was opened.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::plan_card_failure;

    #[test]
    fn a_rejection_keeps_the_server_reason_and_a_failure_does_not() {
        assert_eq!(
            plan_card_failure(
                r#"/v1/cloud/agent-runs/r/agent-plan-card returned 409 Conflict: {"errorCode":"plan_card_exists","message":"This task already opened card plan_1."}"#
            ),
            "The plan card was not saved: This task already opened card plan_1."
        );
        assert_eq!(
            plan_card_failure(
                r#"/v1/cloud/agent-runs/r/agent-plan-card returned 500 Internal Server Error: {"message":"db"}"#
            ),
            "The plan card was not saved. Do not claim a card was opened."
        );
        assert!(plan_card_failure("connection refused").contains("Do not claim"));
    }
}

#[cfg(test)]
#[path = "plan_card_tests.rs"]
mod forwarding_tests;
