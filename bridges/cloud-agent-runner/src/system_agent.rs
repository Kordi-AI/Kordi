//! System agent sweep runs. No sandbox is created; the only reachable tool is
//! `plan_card`, and every call is forwarded to the server bound to this run.

use crate::{
    client::{CloudAgentRun, CloudAgentRunClient, ProviderAuthMaterial},
    model_loop::{CloudModelProvider, ModelLoopError, ModelProviderResponse, OpenAiProviderConfig},
};
use serde_json::{json, Value};

mod fallback;
mod omp;
pub use omp::run as run_omp;

/// Stored run ids keep the old prefix.
pub const RUN_PREFIX: &str = "pip_";

const MAX_MODEL_STEPS: usize = 8;
const MAX_TOOL_CALLS: usize = 48;
const SEMANTIC_MAX_OUTPUT_TOKENS: u32 = 1_536;

const SNAPSHOT_INSTRUCTION: &str = "Use the supplied conversation snapshot and trigger. Follow the facilitator skill and return its JSON reply.";

/// Settings are named `KORDI_SYSTEM_AGENT_*`. The old `KORDI_PIP_*` names are
/// still read so existing deployments keep working; the new name wins.
const SETTING_PREFIXES: [&str; 2] = ["KORDI_SYSTEM_AGENT_", "KORDI_PIP_"];

/// The non-empty value of the setting `suffix`, such as `FALLBACK_MODEL`.
pub(crate) fn setting(get: impl Fn(&str) -> Option<String>, suffix: &str) -> Option<String> {
    SETTING_PREFIXES
        .iter()
        .filter_map(|prefix| get(&format!("{prefix}{suffix}")))
        .find(|value| !value.trim().is_empty())
}

pub fn tools() -> Vec<Value> {
    vec![crate::system_agent_tool::definition()]
}
fn tools_for_input(input: &Value) -> Vec<Value> {
    if input["replyMode"] == "semantic" || input["workflowKind"].is_string() {
        Vec::new()
    } else {
        tools()
    }
}

/// Normalizes the model's final text into the `{message, hooksHandled}`
/// envelope the server expects. A bare sentence becomes a message; the
/// literal words the prompt uses for silence become `null`.
pub fn normalize_output(text: &str) -> String {
    let trimmed = strip_json_fence(text);
    if let Ok(mut value) = serde_json::from_str::<Value>(trimmed) {
        if let Some(object) = value.as_object_mut() {
            object.entry("message").or_insert(Value::Null);
            object.entry("hooksHandled").or_insert_with(|| json!([]));
            return value.to_string();
        }
    }
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("null")
        || trimmed.eq_ignore_ascii_case("silent")
    {
        return json!({"message": null, "hooksHandled": []}).to_string();
    }
    json!({"message": trimmed, "hooksHandled": []}).to_string()
}

fn strip_json_fence(text: &str) -> &str {
    let trimmed = text.trim();
    trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .map(|rest| rest.trim_end_matches("```").trim())
        .unwrap_or(trimmed)
}

async fn finish_output<C: CloudAgentRunClient + Sync>(
    client: &C,
    run: &CloudAgentRun,
    input: &Value,
    text: &str,
) -> String {
    if input["replyMode"] != "semantic" {
        return normalize_output(text);
    }

    let silent = || json!({"message": null, "hooksHandled": []}).to_string();
    let Ok(Value::Object(mut reply)) = serde_json::from_str(strip_json_fence(text)) else {
        return silent();
    };
    let plan = reply.remove("planCard").filter(|plan| !plan.is_null());
    let workflows = reply
        .get("workflowCard")
        .is_some_and(|value| !value.is_null());
    let documents = reply
        .get("documentDraft")
        .is_some_and(|value| !value.is_null());
    if usize::from(plan.is_some()) + usize::from(workflows) + usize::from(documents) > 1 {
        return silent();
    }

    if let Some(plan) = plan {
        if client.plan_card_action(&run.run_id, plan).await.is_err() {
            tracing::warn!(run_id = %run.run_id, "Facilitator plan proposal was rejected");
            return silent();
        }
    }
    let mut output = json!({
        "message": reply.remove("message").filter(Value::is_string),
        "hooksHandled": [],
    });
    for field in ["workflowCard", "documentDraft"] {
        if let Some(value) = reply.remove(field).filter(Value::is_object) {
            output[field] = value;
        }
    }
    output.to_string()
}

fn apply_semantic_output_budget(auth: &mut OpenAiProviderConfig, input: &Value) {
    if input["replyMode"] == "semantic" {
        auth.max_output_tokens = Some(SEMANTIC_MAX_OUTPUT_TOKENS);
    }
}

pub async fn run<C, P>(
    client: &C,
    provider: &P,
    run: &CloudAgentRun,
    material: ProviderAuthMaterial,
) -> Result<String, ModelLoopError>
where
    C: CloudAgentRunClient + Sync,
    P: CloudModelProvider + Sync,
{
    match crate::runtime::cloud_model_engine_from_env()? {
        crate::runtime::CloudModelEngine::Omp => run_omp(client, run, material).await,
        crate::runtime::CloudModelEngine::Rust => run_legacy(client, provider, run, material).await,
    }
}

/// The built-in Rust engine's loop; `run` picks it when the engine is `rust`.
pub async fn run_legacy<C, P>(
    client: &C,
    provider: &P,
    run: &CloudAgentRun,
    material: ProviderAuthMaterial,
) -> Result<String, ModelLoopError>
where
    C: CloudAgentRunClient + Sync,
    P: CloudModelProvider + Sync,
{
    let input: Value = serde_json::from_str(&run.prompt)
        .map_err(|_| ModelLoopError::Provider("Invalid System agent sweep input".into()))?;
    if input.get("messages").and_then(Value::as_array).is_none() {
        return Err(ModelLoopError::Provider(
            "System agent sweep input has no messages".into(),
        ));
    }
    let mut auth = OpenAiProviderConfig::from_material(&material)?;
    let mut fallback = fallback::configured()?;
    auth.apply_runtime_route(&run.runtime_route, &material.provider)?;
    apply_semantic_output_budget(&mut auth, &input);
    if let Some(backup) = &mut fallback {
        apply_semantic_output_budget(backup, &input);
    }
    let mut messages = vec![
        json!({"role":"system","content":run.system_prompt}),
        json!({"role":"user","content":format!("{SNAPSHOT_INSTRUCTION} Snapshot: {input}")}),
    ];
    let catalog = tools_for_input(&input);
    let mut tool_calls_remaining = MAX_TOOL_CALLS;
    for step in 1..=MAX_MODEL_STEPS {
        match fallback::next_response(provider, &mut auth, &mut fallback, &messages, &catalog)
            .await?
        {
            ModelProviderResponse::FinalText(text) => {
                return Ok(finish_output(client, run, &input, &text).await);
            }
            ModelProviderResponse::ToolCalls(calls) => {
                if catalog.is_empty() {
                    return Err(ModelLoopError::Provider(
                        "Facilitator received an unexpected tool call".into(),
                    ));
                }
                if calls.is_empty() {
                    return Err(ModelLoopError::Provider(
                        "model returned an empty tool call list".into(),
                    ));
                }
                if step == MAX_MODEL_STEPS || calls.len() > tool_calls_remaining {
                    break;
                }
                tool_calls_remaining -= calls.len();
                for call in calls {
                    let result = if call.name == crate::system_agent_tool::NAME {
                        match client
                            .plan_card_action(&run.run_id, call.arguments.clone())
                            .await
                        {
                            Ok(value) => value,
                            Err(err) => {
                                tracing::warn!(run_id = %run.run_id, error = %err, "plan_card call failed");
                                json!({"error": err.to_string()})
                            }
                        }
                    } else {
                        json!({"error": "Tool unavailable. Only plan_card is allowed."})
                    };
                    messages.push(json!({"role":"assistant","tool_calls":[{"id":call.id,"type":"function","function":{"name":call.name,"arguments":call.arguments.to_string()}}]}));
                    messages.push(json!({"role":"tool","tool_call_id":call.id,"name":call.name,"content":result.to_string()}));
                }
            }
        }
    }
    Err(ModelLoopError::Provider(
        "Facilitator reached its model or tool call limit".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_envelope_is_normalized() {
        // Compare parsed JSON: serialized key order depends on whether the
        // build unifies serde_json's `preserve_order` feature.
        let normalized =
            |text: &str| serde_json::from_str::<Value>(&normalize_output(text)).unwrap();
        assert_eq!(
            normalized("{\"message\":\"Card is up.\"}"),
            json!({"hooksHandled": [], "message": "Card is up."})
        );
        assert_eq!(
            normalized("```json\n{\"message\":null,\"hooksHandled\":[\"t_minus_24h\"]}\n```"),
            json!({"hooksHandled": ["t_minus_24h"], "message": null})
        );
        assert_eq!(
            normalized("Still on for tomorrow?"),
            json!({"hooksHandled": [], "message": "Still on for tomorrow?"})
        );
        assert_eq!(
            normalized("  "),
            json!({"hooksHandled": [], "message": null})
        );
    }

    #[tokio::test]
    async fn semantic_reply_keeps_hook_objects_and_conflicting_actions_out_of_chat() {
        let client = crate::client::HttpCloudAgentRunClient::new(
            "http://127.0.0.1:1".into(),
            "fixture".into(),
            "fixture".into(),
        );
        let run: CloudAgentRun = serde_json::from_value(json!({
            "runId": "pip_fixture", "status": "running", "prompt": "{}",
            "ownerAccountId": "fixture", "requesterAccountId": "fixture",
            "sessionId": "fixture", "sandboxId": null, "providerAuthAvailable": false,
        }))
        .unwrap();
        let input = json!({"replyMode": "semantic"});
        assert!(tools_for_input(&input).is_empty());
        for raw in [
            json!({"message": {"unexpected": "text"}, "hooksHandled": [{"name": "new_messages"}]}),
            json!({"message": "Done", "planCard": {"action": "propose"}, "documentDraft": {"title": "Draft"}}),
        ] {
            let output = finish_output(&client, &run, &input, &raw.to_string()).await;
            assert_eq!(
                serde_json::from_str::<Value>(&output).unwrap(),
                json!({"message": null, "hooksHandled": []}),
            );
        }
    }

    #[test]
    fn settings_read_the_new_name_then_the_old_one() {
        let lookup = |pairs: &'static [(&'static str, &'static str)]| {
            move |key: &str| {
                pairs
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| value.to_string())
            }
        };
        let new = lookup(&[("KORDI_SYSTEM_AGENT_FALLBACK_MODEL", "new")]);
        assert_eq!(setting(new, "FALLBACK_MODEL").as_deref(), Some("new"));
        let old = lookup(&[("KORDI_PIP_FALLBACK_MODEL", "old")]);
        assert_eq!(setting(old, "FALLBACK_MODEL").as_deref(), Some("old"));
        let both = lookup(&[
            ("KORDI_PIP_FALLBACK_MODEL", "old"),
            ("KORDI_SYSTEM_AGENT_FALLBACK_MODEL", "new"),
        ]);
        assert_eq!(setting(both, "FALLBACK_MODEL").as_deref(), Some("new"));
        let blank = lookup(&[
            ("KORDI_SYSTEM_AGENT_FALLBACK_MODEL", " "),
            ("KORDI_PIP_FALLBACK_MODEL", "old"),
        ]);
        assert_eq!(setting(blank, "FALLBACK_MODEL").as_deref(), Some("old"));
        assert_eq!(setting(lookup(&[]), "FALLBACK_MODEL"), None);
    }

    #[test]
    fn only_the_plan_card_tool_is_offered() {
        let catalog = tools();
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0]["function"]["name"], "plan_card");
    }
}
