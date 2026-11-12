//! Whom a member's message is for. A member talking to an agent (their own or
//! anyone else's), or a message an agent already answered, is not the System
//! agent's cue to speak: it still reads the message as context, but only plain
//! chat between people can wake it.

use std::collections::{BTreeSet, HashSet};

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::mentions::mention_handle;

fn normalized_handle(value: &str) -> String {
    mention_handle(value).to_lowercase()
}

fn non_empty(value: &Value) -> Option<&str> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// A field of a decoded cloud envelope: on the envelope itself for direct
/// messages, on its `message` for group messages.
fn envelope_field<'a>(envelope: &'a Value, name: &str) -> Option<&'a Value> {
    envelope
        .get(name)
        .filter(|value| !value.is_null())
        .or_else(|| {
            envelope
                .get("message")
                .and_then(|message| message.get(name))
        })
        .filter(|value| !value.is_null())
}

/// Whether a decoded envelope targets or mentions an agent other than the
/// System agent. When a mention does not say what it points at, any handle that
/// is not a member's counts as an agent's.
pub(super) fn addresses_other_agent(
    envelope: &Value,
    system_agent_account_id: &str,
    member_handles: &BTreeSet<String>,
) -> bool {
    let is_system_agent = |value: &str| value.contains(system_agent_account_id);
    if envelope_field(envelope, "targetCloudAgentId")
        .and_then(non_empty)
        .is_some_and(|target| !is_system_agent(target))
    {
        return true;
    }
    envelope_field(envelope, "mentions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|mention| {
            let ids = ["targetIdentityId", "agentId", "humanId"]
                .map(|key| mention.get(key).and_then(non_empty));
            if ids.iter().flatten().any(|id| is_system_agent(id)) {
                return false;
            }
            match mention.get("targetKind").and_then(Value::as_str) {
                Some("agent") => true,
                Some(_) => false,
                None => {
                    ids[1].is_some()
                        || ids[0].is_some_and(|id| id.starts_with("agent:"))
                        || mention
                            .get("label")
                            .and_then(non_empty)
                            .map(normalized_handle)
                            .is_some_and(|handle| {
                                !handle.is_empty()
                                    && handle != "all"
                                    && !member_handles.contains(&handle)
                            })
                }
            }
        })
}

/// Whether a decoded envelope targets or mentions the System agent itself.
pub(super) fn addresses_system_agent(envelope: &Value, system_agent_account_id: &str) -> bool {
    let is_system_agent = |value: &str| value.contains(system_agent_account_id);
    envelope_field(envelope, "targetCloudAgentId")
        .and_then(non_empty)
        .is_some_and(is_system_agent)
        || envelope_field(envelope, "mentions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|mention| {
                ["targetIdentityId", "agentId", "humanId"]
                    .iter()
                    .filter_map(|key| mention.get(*key).and_then(non_empty))
                    .any(is_system_agent)
            })
}

/// A manually typed service handle when the composer has no matching
/// structured target. A member with that name takes precedence.
pub(super) fn starts_with_facilitator_mention(
    text: &str,
    human_handles: &BTreeSet<String>,
) -> bool {
    let Some(text) = text.trim_start().strip_prefix('@') else {
        return false;
    };
    let handle: String = text
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    let handle = handle.to_ascii_lowercase();
    matches!(handle.as_str(), "facilitator" | "system") && !human_handles.contains(&handle)
}

/// Member handles as `addresses_other_agent` compares them.
pub(super) fn member_handles<'a>(display_names: impl Iterator<Item = &'a str>) -> BTreeSet<String> {
    display_names.map(normalized_handle).collect()
}

/// Every id an agent run may name as the message it answers.
pub(super) fn request_ids(
    message_id: &str,
    client_message_id: Option<&str>,
    envelope: Option<&Value>,
) -> Vec<String> {
    let from_envelope = envelope
        .and_then(|envelope| envelope_field(envelope, "id"))
        .and_then(non_empty);
    [Some(message_id), client_message_id, from_envelope]
        .into_iter()
        .flatten()
        .map(str::to_string)
        .collect()
}

/// The ids among `ids` that an agent run (not the System agent's own) answered
/// or is answering. Failed and cancelled runs did not answer.
pub(super) async fn answered_ids(
    pool: &PgPool,
    ids: &[String],
) -> Result<HashSet<String>, sqlx_core::Error> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let rows: Vec<(String,)> = query_as(
        "SELECT DISTINCT request_message_id FROM cloud_agent_fallback_runs
         WHERE request_message_id = ANY($1) AND status NOT IN ('failed', 'cancelled')
           AND run_id NOT LIKE 'pip\\_%'",
    )
    .bind(ids)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Eligible human messages can support a Facilitator action. Old messages
/// can explain the action, but only new messages can initiate it.
pub(super) fn human_messages(input: &Value) -> impl Iterator<Item = &Value> {
    input["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| {
            [
                "fromSystemAgent",
                "addressesAgent",
                "answeredByAgent",
                "agentOwned",
                "fromAgent",
            ]
            .iter()
            .all(|flag| message[*flag] != json!(true))
        })
}

pub(super) fn new_human_messages(input: &Value) -> impl Iterator<Item = &Value> {
    human_messages(input).filter(|message| {
        message["isNew"] == true
            && message["text"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handles() -> BTreeSet<String> {
        member_handles(["Riya Shah", "System", "Alex"].into_iter())
    }

    fn input(message: Value) -> Value {
        let mut message = message;
        message["isNew"] = json!(true);
        message["fromSystemAgent"] = json!(false);
        json!({"messages": [message], "openCard": null})
    }

    #[test]
    fn agent_targets_and_agent_mentions_address_an_agent() {
        let system_agent = "acct_kordi_pip";
        let group = |message: Value| json!({"kind": "group-message", "message": message});
        assert!(addresses_other_agent(
            &group(json!({"text": "check my memory", "targetCloudAgentId": "cloud-agent:acct_a"})),
            system_agent,
            &handles()
        ));
        assert!(addresses_other_agent(
            &json!({"kind": "message", "mentions": [{"label": "KordiAlex", "targetKind": "agent",
                "targetIdentityId": "agent:cloud-agent:acct_a"}]}),
            system_agent,
            &handles()
        ));
        // Old clients send only a label: a handle that is no member's is an agent's.
        assert!(addresses_other_agent(
            &group(json!({"mentions": [{"label": "@KordiMemTesterA"}]})),
            system_agent,
            &handles()
        ));
        assert!(!addresses_other_agent(
            &group(json!({"mentions": [{"label": "@RiyaShah"}]})),
            system_agent,
            &handles()
        ));
        assert!(!addresses_other_agent(
            &json!({"mentions": [{"label": "Riya", "targetKind": "person",
                "targetIdentityId": "human:acct_r"}]}),
            system_agent,
            &handles()
        ));
        // Talking to the System agent itself is not talking to another agent.
        assert!(!addresses_other_agent(
            &json!({"targetCloudAgentId": "cloud-agent:acct_kordi_pip"}),
            system_agent,
            &handles()
        ));
        assert!(!addresses_other_agent(
            &group(json!({"text": "Dinner Friday at 7?"})),
            system_agent,
            &handles()
        ));
        // Asking the System agent itself is a request for it.
        assert!(addresses_system_agent(
            &group(
                json!({"mentions": [{"label": "System", "targetKind": "agent",
                "targetIdentityId": "agent:cloud-agent:acct_kordi_pip"}]})
            ),
            system_agent
        ));
        assert!(addresses_system_agent(
            &json!({"targetCloudAgentId": "cloud-agent:acct_kordi_pip"}),
            system_agent
        ));
        assert!(!addresses_system_agent(
            &group(
                json!({"text": "Dinner Friday at 7?", "targetCloudAgentId": "cloud-agent:acct_a"})
            ),
            system_agent
        ));
    }

    #[test]
    fn request_ids_cover_server_client_and_envelope_ids() {
        let envelope = json!({"message": {"id": "local-1"}});
        assert_eq!(
            request_ids("m1", Some("c1"), Some(&envelope)),
            vec!["m1", "c1", "local-1"]
        );
        assert_eq!(request_ids("m1", None, None), vec!["m1"]);
    }

    #[test]
    fn messages_for_an_agent_or_already_answered_do_not_wake_system_agent() {
        let plain = json!({"text": "Can we meet Friday at 7?"});
        assert_eq!(new_human_messages(&input(plain.clone())).count(), 1);
        let mut addressed = plain.clone();
        addressed["addressesAgent"] = json!(true);
        assert_eq!(new_human_messages(&input(addressed)).count(), 0);
        let mut answered = plain;
        answered["answeredByAgent"] = json!(true);
        assert_eq!(new_human_messages(&input(answered)).count(), 0);
    }

    #[test]
    fn facilitator_requests_respect_member_names_and_other_agent_ownership() {
        assert!(starts_with_facilitator_mention(
            "@Facilitator, could you help?",
            &handles()
        ));
        assert!(!starts_with_facilitator_mention(
            "@System can you help?",
            &handles()
        ));
        assert!(starts_with_facilitator_mention(
            "@System can you help?",
            &BTreeSet::new()
        ));
        assert!(!starts_with_facilitator_mention(
            "Riya said @Facilitator",
            &handles()
        ));
        assert!(!starts_with_facilitator_mention(
            "@Facilitator_bot",
            &handles()
        ));
    }
}
