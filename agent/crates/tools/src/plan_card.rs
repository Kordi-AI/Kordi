//! `plan_card`: a person's agent opens and updates the shared plan or vote
//! card for a plan it is settling in a direct chat or group (issue #2446).
//!
//! The runtime forwards each call to the server under the run's lease; the
//! server binds it to the run's conversation, checks membership, and keeps
//! one card per task. The schema and description are static so a run's tool
//! list stays byte-identical from one run to the next.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::support::text_result;
use crate::{Tool, ToolContext, ToolMetadata, ToolResult, ToolRiskLevel};

pub const NAME: &str = "plan_card";

const DESCRIPTION: &str = "Open or update the shared card for a plan you are settling in this chat, instead of only writing the plan in a message. Members answer, vote, and confirm on the card, and a confirmed plan goes on their Kordi calendars. Use kind vote with 2 to 4 options when people need to choose between times, places, or ideas, instead of listing the choices in chat. Use kind plan once a plan is concrete: a time is agreed, or one proposal people should confirm. Put what is still open in openItems, for example \"place\". Open one card per plan: later changes, including turning a decided vote into the plan, use update with the eventId that create returned. Never open a second card for the same plan.";

/// One call as the runtime forwards it: `action` is `create` or `update`,
/// and `arguments` are the model's arguments unchanged.
#[derive(Clone, Debug, PartialEq)]
pub struct PlanCardRequest {
    pub tool_call_id: Option<String>,
    pub action: String,
    pub arguments: Value,
}

pub type PlanCardFuture = Pin<Box<dyn Future<Output = KordiResult<Value>> + Send>>;
pub type PlanCardFn = Arc<dyn Fn(PlanCardRequest) -> PlanCardFuture + Send + Sync>;

/// Present only on a run that may open cards in its conversation.
#[derive(Clone)]
pub struct PlanCardRuntime {
    pub call: PlanCardFn,
}

pub struct PlanCardTool;

/// The tool's JSON schema; shared with the cloud runner's catalog.
pub fn parameters_schema() -> Value {
    let instant = |what: &str| json!({"type": "string", "description": format!("{what} as RFC 3339 with the timezone offset, for example 2026-11-14T10:00:00-08:00.")});
    json!({
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["create", "update"]},
            "kind": {"type": "string", "enum": ["plan", "vote"], "description": "plan for one concrete plan; vote to let people choose between options."},
            "eventId": {"type": "string", "description": "For update: the card's eventId from create."},
            "title": {"type": "string", "description": "Short title, for example 'Coffee chat'. Required for create."},
            "startAt": instant("Start"),
            "endAt": instant("End"),
            "location": {"type": "string"},
            "openItems": {"type": "array", "items": {"type": "string"}, "description": "Details still open, for example [\"place\"]. On update, an empty list clears them."},
            "options": {
                "type": "array",
                "description": "For kind vote: 2 to 4 choices.",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "description": "Short choice text, for example 'Sat 10:00'."},
                        "startAt": instant("Start of this choice"),
                        "endAt": instant("End of this choice"),
                        "location": {"type": "string"}
                    },
                    "required": ["label"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["action"],
        "additionalProperties": false
    })
}

pub fn description() -> &'static str {
    DESCRIPTION
}

#[async_trait]
impl Tool for PlanCardTool {
    fn name(&self) -> &str {
        NAME
    }

    fn description(&self) -> &str {
        DESCRIPTION
    }

    fn parameters_schema(&self) -> Value {
        parameters_schema()
    }

    /// Any member may ask the agent to plan; the server checks that the
    /// request and its owner belong to the conversation.
    fn allows_shared_requests(&self) -> bool {
        true
    }

    fn metadata(&self) -> ToolMetadata {
        ToolMetadata::operator(ToolRiskLevel::Medium)
    }

    async fn execute(
        &self,
        params: Value,
        ctx: &ToolContext,
        cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        let action = params
            .get("action")
            .and_then(Value::as_str)
            .map(str::trim)
            // `propose` is the System agent's name; the server maps it.
            .filter(|action| matches!(*action, "create" | "update" | "propose"))
            .ok_or_else(|| KordiError::Tool("plan_card action must be create or update".into()))?
            .to_string();
        let Some(runtime) = ctx.plan_card.clone() else {
            return Err(KordiError::Tool(
                "plan_card is unavailable in this conversation. Do not claim a card was opened."
                    .into(),
            ));
        };
        let request = PlanCardRequest {
            tool_call_id: ctx.invocation_id.clone(),
            action,
            arguments: params,
        };
        let result = tokio::select! {
            result = (runtime.call)(request) => result?,
            _ = cancel.cancelled() => return Err(KordiError::Tool("plan_card cancelled".into())),
        };
        Ok(text_result(summary(&result), Some(result)))
    }
}

/// What the model reads back: the card id to update later and the card.
pub fn summary(result: &Value) -> String {
    format!(
        "The {} card is in the chat. eventId: {}. Update this card for any change to the plan.\n{}",
        result["kind"].as_str().unwrap_or("plan"),
        result["eventId"].as_str().unwrap_or_default(),
        result["card"]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(runtime: Option<PlanCardRuntime>) -> ToolContext {
        ToolContext {
            invocation_id: Some("call_1".into()),
            plan_card: runtime,
            ..ToolContext::default()
        }
    }

    #[test]
    fn the_schema_is_static_and_allows_shared_requests() {
        assert_eq!(PlanCardTool.parameters_schema(), parameters_schema());
        assert_eq!(PlanCardTool.description(), description());
        assert!(PlanCardTool.allows_shared_requests());
        assert_eq!(parameters_schema()["required"], json!(["action"]));
    }

    #[tokio::test]
    async fn a_call_without_a_runtime_fails_closed() {
        let error = PlanCardTool
            .execute(
                json!({"action": "create", "title": "Coffee"}),
                &context(None),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("unavailable"));
        let error = PlanCardTool
            .execute(
                json!({"action": "delete"}),
                &context(None),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("create or update"));
    }

    #[tokio::test]
    async fn a_call_forwards_the_arguments_and_returns_the_card_id() {
        let seen = Arc::new(std::sync::Mutex::new(None));
        let recorded = seen.clone();
        let runtime = PlanCardRuntime {
            call: Arc::new(move |request: PlanCardRequest| {
                *recorded.lock().unwrap() = Some(request);
                Box::pin(async {
                    Ok(json!({"eventId": "plan_1", "kind": "vote", "card": {"revision": 1}}))
                })
            }),
        };
        let result = PlanCardTool
            .execute(
                json!({"action": "create", "kind": "vote", "title": "Coffee"}),
                &context(Some(runtime)),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let request = seen.lock().unwrap().clone().unwrap();
        assert_eq!(request.action, "create");
        // The System agent's `propose` reaches the server, which maps it.
        let ctx = context(Some(PlanCardRuntime {
            call: Arc::new(|request: PlanCardRequest| {
                Box::pin(async move {
                    assert_eq!(request.action, "propose");
                    Ok(json!({"eventId": "plan_2", "kind": "plan", "card": {}}))
                })
            }),
        }));
        PlanCardTool
            .execute(
                json!({"action": "propose", "state": "awaitingConfirmation", "title": "Coffee"}),
                &ctx,
                CancellationToken::new(),
            )
            .await
            .expect("propose is forwarded");
        assert_eq!(request.tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(request.arguments["title"], "Coffee");
        let text = format!("{:?}", result.content);
        assert!(text.contains("eventId: plan_1"), "{text}");
    }
}
