//! Publish an approved assignment as an addressed request with one durable agent reply slot.

use chrono::Utc;
use serde_json::json;
use sqlx_core::{query_as::query_as, transaction::Transaction};
use sqlx_postgres::Postgres;
use uuid::Uuid;

use crate::chat_sync::{models::SendMessageRequest, store::send_message_in_transaction};
use crate::cloud_agent_runtime::sync_events::deterministic_message_uuid;
use crate::proactive::proposal::Proposal;

use super::envelopes::{
    cloud_group_response_body, encode_cloud_group_envelope, CloudGroupEnvelope, CloudGroupMessage,
};
use super::plain_group_request::conversation_participants;

pub(super) const REQUEST_PREFIX: &str = "facilitator-handoff:";

pub(super) fn request_client_id(request_id: &str) -> Uuid {
    Uuid::new_v5(&Uuid::NAMESPACE_OID, request_id.as_bytes())
}

fn content(body: String) -> serde_json::Value {
    json!({"schema":1,"blocks":[{"type":"text","text":body}],"legacy_attachments":[]})
}

/// The mention, queued reply and owner-authorized run are committed together.
/// The durable run answers this actual group message on both the Mac and cloud.
pub(crate) async fn post(
    tx: &mut Transaction<'_, Postgres>,
    proposal: &Proposal,
    run_id: &str,
) -> sqlx_core::Result<String> {
    let card_id = proposal
        .proposal_id
        .strip_prefix("facilitator-task-")
        .and_then(|id| Uuid::parse_str(id).ok())
        .ok_or(sqlx_core::Error::RowNotFound)?;
    let (sender, card_message, created_by, group_space): (String, Uuid, String, Option<String>) = query_as(
        "SELECT card.sender_account_id, card.message_id, conversation.created_by_account_id, conversation.group_space_id
         FROM cloud_facilitator_cards card
         JOIN cloud_chat_conversations conversation ON conversation.conversation_id = card.conversation_id
         WHERE card.card_id = $1 AND card.conversation_id = $2 AND card.kind = 'task'
           AND card.message_id IS NOT NULL AND conversation.kind = 'group'",
    ).bind(card_id).bind(proposal.conversation_id).fetch_one(&mut **tx).await?;
    let participants = conversation_participants(tx, proposal.conversation_id).await?;
    let actor = participants
        .iter()
        .find(|member| member.account_id == sender)
        .cloned()
        .ok_or(sqlx_core::Error::RowNotFound)?;
    let owner = participants
        .iter()
        .find(|member| member.account_id == proposal.owner_account_id)
        .ok_or(sqlx_core::Error::RowNotFound)?;
    let display_label = &proposal.agent_name;
    let visible = format!("@{display_label}");
    let now = Utc::now().timestamp_millis();
    let request_id = format!("{REQUEST_PREFIX}{card_id}");
    let request = CloudGroupEnvelope {
        kind: "group-message".into(),
        group_id: proposal.session_id.clone(),
        group_space_id: group_space,
        group_title: proposal.conversation_title.clone(),
        created_by_account_id: created_by,
        actor,
        message: Some(CloudGroupMessage {
            id: request_id.clone(),
            sender_account_id: sender.clone(),
            text: format!(
                "{visible} Please take this approved assignment: {}.",
                proposal.problem.trim_end_matches('.')
            ),
            created_at_ms: now,
            mentions: Some(vec![json!({
                "label": crate::system_agent::mentions::agent_mention_handle(owner.agent_display_name.as_deref(), &owner.display_name),
                "targetKind": "agent", "targetIdentityId": format!("agent:{}", proposal.agent_id),
                "agentId": proposal.agent_id, "ownerAccountId": owner.account_id,
                "sourceHostId": "cloud", "displayLabel": display_label, "displayText": visible,
                "startUtf16": 0, "lengthUtf16": visible.encode_utf16().count(),
            })]),
            sender_kind: Some("agent".into()),
            target_cloud_agent_id: Some(proposal.agent_id.clone()),
            target_cloud_agent_name: Some(proposal.agent_name.clone()),
            target_cloud_agent_owner_account_id: Some(owner.account_id.clone()),
            target_cloud_agent_owner_name: Some(owner.display_name.clone()),
            fork_snapshot: None,
            sender_agent_id: None,
            sender_owner_account_id: None,
            sender_owner_name: None,
            sender_display_name: None,
            delivery_state: None,
            reply_to_message_id: None,
            request_id: None,
            message_action: None,
            agent_mention_depth: Some(super::group_mentions::CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH),
        }),
        participants,
    };
    let sent = send_message_in_transaction(
        tx,
        &sender,
        proposal.conversation_id,
        SendMessageRequest {
            client_message_id: request_client_id(&request_id),
            kind: "text".into(),
            content: content(encode_cloud_group_envelope(&request)),
            reply_to_message_id: Some(card_message),
            attachment_ids: Vec::new(),
        },
    )
    .await
    .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    let body = cloud_group_response_body(
        &request,
        &proposal.owner_account_id,
        &request_id,
        run_id,
        "",
        "queued",
        now,
    );
    let client_message_id =
        deterministic_message_uuid(&proposal.session_id, &proposal.owner_account_id, run_id);
    send_message_in_transaction(
        tx,
        &proposal.owner_account_id,
        proposal.conversation_id,
        SendMessageRequest {
            client_message_id,
            kind: "text".into(),
            content: content(body),
            reply_to_message_id: Some(sent.value.id),
            attachment_ids: Vec::new(),
        },
    )
    .await
    .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    Ok(request_id)
}
