//! The Facilitator's reply row in a group, in the same reply-slot shape as a
//! member agent's (#2416, #2547): a processing row answering the request,
//! edited in place into the reply. The Facilitator never hands work to
//! another agent through this row, so it carries no agent target.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::Value;

use super::envelopes::{
    cloud_agent_shared_failure_text, cloud_group_response_body, parse_cloud_group_envelope,
};
use super::group_mentions::CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH;

const CLOUD_GROUP_PREFIX: &str = "kordi-cloud-group:";

/// The line a failed Facilitator reply shows, as a member agent's does.
pub(crate) fn failure_text() -> String {
    cloud_agent_shared_failure_text(Some(crate::system_agent::DEFAULT_SYSTEM_AGENT_NAME))
}

/// The group message id of the request a stored body carries.
pub(crate) fn request_id(request_body: &str) -> Option<String> {
    let envelope = parse_cloud_group_envelope(request_body)?;
    let id = envelope.message?.id;
    (!id.trim().is_empty()).then_some(id)
}

/// One state of the Facilitator's reply row: "processing" with empty text
/// while it works, then "complete" or "failed" with its words and mentions.
pub(crate) struct ReplyRow<'a> {
    pub system_agent: &'a str,
    /// The Facilitator's agent id, when it is set up on this server.
    pub agent_id: Option<&'a str>,
    pub slot_id: &'a str,
    pub text: &'a str,
    pub delivery_state: &'a str,
    pub mentions: Vec<Value>,
    pub created_at_ms: i64,
}

/// The reply row body for the group request in `request_body`. None when
/// the request is not a group message.
pub(crate) fn reply_body(request_body: &str, row: ReplyRow<'_>) -> Option<String> {
    let ReplyRow {
        system_agent,
        agent_id,
        slot_id,
        text,
        delivery_state,
        mentions,
        created_at_ms,
    } = row;
    let mut request = parse_cloud_group_envelope(request_body)?;
    let message = request.message.as_mut()?;
    let request_id = message.id.clone();
    // The reply answers as the Facilitator, and never as a mention hand-off.
    message.target_cloud_agent_id = None;
    message.target_cloud_agent_name = None;
    message.agent_mention_depth = Some(CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH);
    let body = cloud_group_response_body(
        &request,
        system_agent,
        &request_id,
        slot_id,
        text,
        delivery_state,
        created_at_ms,
    );
    let mut envelope: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(body.strip_prefix(CLOUD_GROUP_PREFIX)?)
            .ok()?,
    )
    .ok()?;
    let name = crate::system_agent::DEFAULT_SYSTEM_AGENT_NAME;
    let reply = envelope.get_mut("message")?.as_object_mut()?;
    // Named by its agent, so the server keeps the Facilitator's name and
    // clients know it as the Facilitator.
    if let Some(agent_id) = agent_id {
        reply.insert("senderAgentId".into(), agent_id.into());
    }
    reply.insert("senderDisplayName".into(), name.into());
    reply.insert("senderOwnerName".into(), name.into());
    reply.remove("agentMentionDepth");
    // An agent mention in a group reply from the Facilitator would start
    // that agent; this row only answers, so it keeps people's mentions.
    let people: Vec<Value> = mentions
        .into_iter()
        .filter(|mention| mention["targetKind"] != "agent")
        .collect();
    if !people.is_empty() {
        reply.insert("mentions".into(), Value::Array(people));
    }
    Some(format!(
        "{CLOUD_GROUP_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(envelope.to_string())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> String {
        let envelope = json!({
            "kind": "group-message", "groupId": "session:group:g", "createdByAccountId": "acct_bea",
            "actor": {"accountId": "acct_bea", "displayName": "Bea"},
            "participants": [{"accountId": "acct_bea", "displayName": "Bea"},
                             {"accountId": "acct_alex", "displayName": "Alex", "agentDisplayName": "Kordi"}],
            "message": {"id": "request-1", "senderAccountId": "acct_bea", "text": "@Facilitator hi",
                "createdAtMs": 1, "mentions": [{"label": "Facilitator", "targetKind": "agent",
                "targetIdentityId": "agent:cloud-agent:acct_kordi_pip"}]}
        });
        format!(
            "{CLOUD_GROUP_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(envelope.to_string())
        )
    }

    fn row<'a>(
        agent_id: Option<&'a str>,
        text: &'a str,
        delivery_state: &'a str,
        mentions: Vec<Value>,
    ) -> ReplyRow<'a> {
        ReplyRow {
            system_agent: "acct_kordi_pip",
            agent_id,
            slot_id: "pip_1",
            text,
            delivery_state,
            mentions,
            created_at_ms: 5,
        }
    }

    fn decode(body: &str) -> Value {
        let encoded = body.strip_prefix(CLOUD_GROUP_PREFIX).unwrap();
        serde_json::from_slice::<Value>(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap()
            ["message"]
            .clone()
    }

    #[test]
    fn the_row_answers_as_the_facilitator_and_hands_nothing_off() {
        assert_eq!(request_id(&request()).as_deref(), Some("request-1"));
        assert_eq!(request_id("plain text"), None);
        let processing = decode(
            &reply_body(
                &request(),
                row(Some("cloud_agent_kordi_pip"), "", "processing", vec![]),
            )
            .unwrap(),
        );
        assert_eq!(processing["senderKind"], "agent");
        assert_eq!(processing["senderAccountId"], "acct_kordi_pip");
        assert_eq!(processing["senderDisplayName"], "Facilitator");
        assert_eq!(processing["senderAgentId"], "cloud_agent_kordi_pip");
        assert_eq!(processing["deliveryState"], "processing");
        assert_eq!(processing["requestId"], "request-1");
        assert_eq!(processing["id"], "pip_1");
        assert_eq!(processing["text"], "");

        let mention = json!({"label": "Alex", "targetKind": "person", "humanId": "acct_alex"});
        let agent = json!({"label": "KordiAlex", "targetKind": "agent",
            "targetIdentityId": "agent:cloud-agent:acct_alex"});
        let reply = decode(
            &reply_body(
                &request(),
                row(
                    None,
                    "@KordiAlex can help, @Alex.",
                    "complete",
                    vec![agent, mention.clone()],
                ),
            )
            .unwrap(),
        );
        assert_eq!(reply["deliveryState"], "complete");
        assert_eq!(reply["text"], "@KordiAlex can help, @Alex.");
        assert_eq!(
            reply["mentions"],
            json!([mention]),
            "an agent mention would start it"
        );
        assert!(
            reply.get("targetCloudAgentId").is_none(),
            "no hand-off: {reply}"
        );
        assert!(reply.get("agentMentionDepth").is_none());
        assert_eq!(
            reply_body("plain", row(None, "", "processing", vec![])),
            None
        );
    }
}
