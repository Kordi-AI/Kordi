//! Materializes a requested Markdown draft with the normal group document store.

use std::borrow::Cow;

use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::query_scalar::query_scalar;
use uuid::Uuid;

use super::store::active_run;
use crate::connectors::models::RunTrigger;
use crate::document_shares::agents::{
    create,
    gating::{RunFacts, ToolGate},
};
use crate::server::ServerState;

const MAX_DRAFT_BYTES: usize = 12_000;
const MAX_SOURCES: usize = 8;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Draft {
    title: String,
    content: String,
    request_message_id: Uuid,
    request_quote: String,
    source_message_ids: Vec<Uuid>,
}

impl Draft {
    fn supported_by(&self, input: &Value) -> bool {
        let request_quote = self.request_quote.trim();
        super::triggers::allows_workflows(input)
            && !input["workflowKind"].is_string()
            && !self.title.trim().is_empty()
            && !self.content.trim().is_empty()
            && self.content.len() <= MAX_DRAFT_BYTES
            && (1..=MAX_SOURCES).contains(&self.source_message_ids.len())
            && self.source_message_ids.contains(&self.request_message_id)
            && !request_quote.is_empty()
            && super::addressing::new_human_messages(input).any(|message| {
                message["messageId"]
                    .as_str()
                    .and_then(|id| Uuid::parse_str(id).ok())
                    == Some(self.request_message_id)
                    && message["text"]
                        .as_str()
                        .is_some_and(|text| text.contains(request_quote))
            })
            && self.source_message_ids.iter().all(|id| {
                super::addressing::human_messages(input).any(|message| {
                    message["messageId"]
                        .as_str()
                        .and_then(|id| Uuid::parse_str(id).ok())
                        == Some(*id)
                })
            })
    }
}

/// Uses the leased run's conversation and evidence, never identifiers from a
/// draft, to select the writer and destination. A provider reply cannot widen
/// the document tool permissions of any other run.
pub(crate) async fn prepare<'a>(
    state: &ServerState,
    run_id: &str,
    runner_id: &str,
    text: &'a str,
) -> Cow<'a, str> {
    if !run_id.starts_with(super::RUN_PREFIX) {
        return Cow::Borrowed(text);
    }
    let Some(mut reply) = serde_json::from_str::<Value>(text).ok() else {
        return Cow::Borrowed(text);
    };
    let Some(value) = reply
        .as_object_mut()
        .and_then(|reply| reply.remove("documentDraft"))
    else {
        return Cow::Borrowed(text);
    };
    if value.is_null() {
        return Cow::Borrowed(text);
    }
    if !reply["workflowCard"].is_null() {
        reply.as_object_mut().unwrap().remove("workflowCard");
        reply["message"] = Value::Null;
        return Cow::Owned(reply.to_string());
    }
    let draft = serde_json::from_value::<Draft>(value);
    let saved = match draft {
        Ok(draft) => save(state, run_id, runner_id, draft).await,
        Err(_) => false,
    };
    if !saved {
        reply["message"] = json!("I couldn't save the document draft.");
    }
    Cow::Owned(reply.to_string())
}

async fn save(state: &ServerState, run_id: &str, runner_id: &str, mut draft: Draft) -> bool {
    let pool = state.db_pool();
    let Some(agent) = state.system_agent().map(|service| service.config()) else {
        return false;
    };
    let Ok(Some(run)) = active_run(pool, run_id, runner_id).await else {
        return false;
    };
    if run.owner_account_id != agent.account_id || !draft.supported_by(&run.input) {
        return false;
    }
    draft.source_message_ids.sort_unstable();
    draft.source_message_ids.dedup();
    // The members can remove a source or revoke AI consent while the model runs.
    let allowed: Result<i64, _> = query_scalar(
        "SELECT COUNT(*) FROM cloud_chat_messages message
         JOIN cloud_accounts account ON account.account_id = message.sender_account_id
         WHERE message.conversation_id = $1 AND message.message_id = ANY($2)
           AND message.deleted_at IS NULL AND account.ai_consent_status = 'allowed'
           AND EXISTS (
               SELECT 1 FROM cloud_agent_fallback_runs lease
               WHERE lease.run_id = $4 AND lease.claimed_by = $5
                 AND lease.status IN ('leased', 'running')
                 AND lease.lease_expires_at::timestamptz > now()
           )
           AND (message.message_id <> $3 OR EXISTS (
               SELECT 1 FROM cloud_chat_conversation_members member
               WHERE member.conversation_id = message.conversation_id
                 AND member.account_id = message.sender_account_id
                 AND member.membership_state = 'active'
           ))",
    )
    .bind(run.conversation_id)
    .bind(&draft.source_message_ids)
    .bind(draft.request_message_id)
    .bind(run_id)
    .bind(runner_id)
    .fetch_one(pool)
    .await;
    if allowed.ok() != Some(draft.source_message_ids.len() as i64) {
        return false;
    }
    let facts = RunFacts {
        owner_account_id: run.owner_account_id.clone(),
        requester_account_id: run.owner_account_id,
        agent_id: agent.agent_id.clone(),
        session_id: run.session_id,
        document: None,
        gate: ToolGate {
            comment_run: false,
            trigger: RunTrigger::Background,
            scheduled: false,
            public_reader: false,
            requester_can_edit: false,
            session_has_document: false,
            group_session: true,
            owner_request: false,
            background_session: false,
        },
    };
    let args = json!({
        "title": format!("Draft - {}", draft.title.trim()),
        "content": draft.content,
        "format": "markdown",
    });
    create::execute(state, run_id, &facts, &args).await.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_draft_needs_a_request_and_cited_group_evidence() {
        let message_id = Uuid::new_v4();
        let request = "Please write a group recap as a document.";
        let mut input = json!({
            "trigger": {"kind": "request"},
            "messages": [{"messageId": message_id, "text": request, "isNew": true}]
        });
        let mut draft = Draft {
            title: "Review notes".into(),
            content: "# Review\nThe group chose the import flow.".into(),
            request_message_id: message_id,
            request_quote: request.into(),
            source_message_ids: vec![message_id],
        };
        assert!(draft.supported_by(&input));
        input["trigger"]["kind"] = json!("silence");
        assert!(draft.supported_by(&input));
        input["trigger"]["kind"] = json!("loop");
        assert!(!draft.supported_by(&input));
        input["trigger"]["kind"] = json!("request");
        input["messages"][0]["text"] = json!("@Facilitator What did we decide?");
        assert!(!draft.supported_by(&input));
        input["messages"][0]["text"] = json!(request);
        input["messages"][0]["isNew"] = json!(false);
        assert!(!draft.supported_by(&input));
        input["messages"][0]["isNew"] = json!(true);
        input["messages"][0]["fromSystemAgent"] = json!(true);
        assert!(!draft.supported_by(&input));
        input["messages"][0]["fromSystemAgent"] = json!(false);
        draft.source_message_ids.push(Uuid::new_v4());
        assert!(!draft.supported_by(&input));
        draft.source_message_ids.pop();
        draft.content = "x".repeat(MAX_DRAFT_BYTES + 1);
        assert!(!draft.supported_by(&input));
    }
}
