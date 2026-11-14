use super::envelopes::LeaseResponse;
use super::{parse_response, RunnerClientError};

const LEASE_PATH: &str = "/v1/cloud/agent-runs/lease";

fn lease_body(turn_identity: serde_json::Value, status: serde_json::Value) -> String {
    serde_json::json!({
        "run": {
            "runId": "cg_card_unnamed",
            "status": status,
            "prompt": "Synthetic evidence that must stay out of logs",
            "systemPrompt": "Synthetic instructions",
            "ownerAccountId": "acct_service",
            "requesterAccountId": "acct_member",
            "sessionId": "common-ground:acct_member",
            "sandboxId": null,
            "runtimeRoute": { "defaultModel": "openai/gpt-5-mini" },
            "providerAuthAvailable": true,
            "turnIdentity": turn_identity,
            "trigger": "background",
            "connectorAudience": "owner_private",
            "connectorTools": []
        }
    })
    .to_string()
}

fn identity(requester_name: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "requestId": "cg_card_unnamed",
        "agentId": "cloud-agent:acct_service",
        "agentName": "Facilitator",
        "ownerAccountId": "acct_service",
        "ownerName": "Facilitator",
        "requesterAccountId": "acct_member",
        "requesterName": requester_name,
    })
}

/// A requester without a display name used to make every lease of their
/// run unreadable, so the run stayed leased and was retried forever.
#[test]
fn a_lease_for_a_requester_without_a_name_is_read() {
    let body = lease_body(identity(serde_json::Value::Null), "leased".into());
    let lease: LeaseResponse = parse_response(LEASE_PATH, &body).unwrap();
    let run = lease.run.unwrap();
    assert_eq!(run.run_id, "cg_card_unnamed");
    let identity = run.turn_identity.unwrap();
    assert_eq!(identity.requester_name, "Participant");
    assert_eq!(identity.owner_name, "Facilitator");
}

#[test]
fn an_identity_that_does_not_fit_is_left_out_of_the_lease() {
    let body = lease_body(serde_json::json!({ "agentId": 7 }), "leased".into());
    let lease: LeaseResponse = parse_response(LEASE_PATH, &body).unwrap();
    assert!(lease.run.unwrap().turn_identity.is_none());
}

#[test]
fn an_unreadable_lease_names_its_run_without_quoting_content() {
    // A string where a string is not expected makes serde quote the value.
    let body = lease_body(identity("Member".into()), "leased".into()).replace(
        "\"providerAuthAvailable\":true",
        "\"providerAuthAvailable\":\"Synthetic evidence that must stay out of logs\"",
    );
    let error = parse_response::<LeaseResponse>(LEASE_PATH, &body).unwrap_err();
    assert_eq!(error.run_id(), Some("cg_card_unnamed"));
    let chain = error.chain();
    assert!(chain.contains("cg_card_unnamed"), "{chain}");
    assert!(chain.contains("could not be read"), "{chain}");
    assert!(!chain.contains("Synthetic evidence"), "{chain}");
}

#[test]
fn errors_tie_to_one_run_only() {
    let error = RunnerClientError::Request("lost".into())
        .for_run("run_a")
        .for_run("run_b");
    assert_eq!(error.run_id(), Some("run_a"));
    assert_eq!(
        error.chain(),
        "cloud run run_a step failed: cloud runner client request failed: lost"
    );
}
