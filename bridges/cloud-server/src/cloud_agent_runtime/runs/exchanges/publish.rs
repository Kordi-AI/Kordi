//! Messages an agent exchange posts in the conversation: the asking agent's
//! questions and requests, and the answering agent's reply slot.
use super::store::Parent;
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;

/// A plain message from the agent: a question or a request to someone. It
/// carries no exchange status; whoever it addresses is named in `mentions`.
#[allow(clippy::too_many_arguments)]
pub(super) async fn publish(
    tx: &mut Transaction<'_, Postgres>,
    parent: &Parent,
    owner: &str,
    agent: &str,
    request: &str,
    text: &str,
    reply: Option<Uuid>,
    mentions: Vec<Value>,
) -> RunResult<Uuid> {
    publish_with(
        tx, parent, owner, agent, request, text, reply, "complete", mentions,
    )
    .await
}

/// A reply slot's row in `state`.
#[allow(clippy::too_many_arguments)]
pub(super) async fn publish_state(
    tx: &mut Transaction<'_, Postgres>,
    parent: &Parent,
    owner: &str,
    agent: &str,
    request: &str,
    text: &str,
    reply: Option<Uuid>,
    state: &str,
) -> RunResult<Uuid> {
    publish_with(
        tx,
        parent,
        owner,
        agent,
        request,
        text,
        reply,
        state,
        Vec::new(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn publish_with(
    tx: &mut Transaction<'_, Postgres>,
    parent: &Parent,
    owner: &str,
    agent: &str,
    request: &str,
    text: &str,
    reply: Option<Uuid>,
    state: &str,
    mentions: Vec<Value>,
) -> RunResult<Uuid> {
    let row: (String,String)=query_as("SELECT a.display_name,COALESCE((SELECT name FROM cloud_agent_definitions WHERE agent_id=$2 AND owner_account_id=$1),p.display_name,'Kordi') FROM cloud_accounts a LEFT JOIN cloud_default_agent_profiles p ON p.owner_account_id=a.account_id WHERE a.account_id=$1")
        .bind(owner).bind(agent).fetch_one(&mut **tx).await?;
    // A run's processing row becomes its answer in place, including retries.
    let slot = super::slots::slot_id(request);
    let id = slot.unwrap_or_else(Uuid::new_v4);
    // A question or request is a plain message from the start; only a result
    // row carries the completed status.
    let completed = (state == "complete" && !request.ends_with(":sent")).then_some("completed");
    let created_at: Option<(Value,)> = if slot.is_some() {
        query_as("SELECT content FROM cloud_chat_messages WHERE sender_account_id=$1 AND client_message_id=$2")
            .bind(owner).bind(id).fetch_optional(&mut **tx).await?
    } else {
        None
    };
    let created_at = created_at
        .and_then(|(content,)| {
            let body = content["blocks"][0]["text"].as_str()?.split_once(':')?.1;
            let wire: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).ok()?).ok()?;
            wire["message"]["createdAtMs"].as_i64()
        })
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    let participants:Vec<(String,String)>=query_as("SELECT a.account_id,a.display_name FROM cloud_chat_conversation_members m JOIN cloud_accounts a USING(account_id) WHERE m.conversation_id=$1 AND m.membership_state='active'")
        .bind(parent.conversation).fetch_all(&mut **tx).await?;
    let participants: Vec<Value> = participants
        .into_iter()
        .map(|(id, name)| json!({"accountId":id,"displayName":name}))
        .collect();
    let body = if parent.kind == "group" {
        // A group can have several channels; the session identifies the channel,
        // while the persisted space identifies the shared group and its members.
        let (space,): (Option<String>,) = query_as(
            "SELECT group_space_id FROM cloud_chat_conversations WHERE conversation_id=$1",
        )
        .bind(parent.conversation)
        .fetch_one(&mut **tx)
        .await?;
        let space = space.as_deref().unwrap_or(&parent.session);
        let mut value = json!({"kind":"group-message","groupId":parent.session,"groupSpaceId":space,"createdByAccountId":parent.requester,"actor":{"accountId":owner,"displayName":row.0,"avatarUrl":null},"participants":participants,"message":{"id":id,"senderAccountId":owner,"senderKind":"agent","senderAgentId":agent,"senderOwnerAccountId":owner,"senderOwnerName":row.0,"senderDisplayName":row.1,"text":text,"createdAtMs":created_at,"deliveryState":state,"requestId":request,"agentMentionDepth":1,"structuredContent":{"agentExchangeStatus":completed}}});
        if !mentions.is_empty() {
            value["message"]["mentions"] = json!(mentions);
        }
        if completed.is_none() {
            value["message"]["structuredContent"] = json!({});
        }
        format!(
            "kordi-cloud-group:{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).map_err(|_| RunError::NotFound)?)
        )
    } else {
        let mut value = json!({"kind":"agent-response","requestId":request,"text":text,"deliveryState":state,"agentExchangeStatus":completed});
        if !mentions.is_empty() {
            value["mentions"] = json!(mentions);
        }
        if completed.is_none() {
            value
                .as_object_mut()
                .expect("object")
                .remove("agentExchangeStatus");
        }
        format!(
            "kordi-cloud-agent-response:{}",
            URL_SAFE_NO_PAD.encode(value.to_string())
        )
    };
    let content = json!({"schema":1,"blocks":[{"type":"text","text":body}]});
    if slot.is_some() {
        if let Some(message) = crate::chat_sync::store::replace_server_message_in_transaction(
            tx,
            owner,
            id,
            "text",
            content.clone(),
        )
        .await
        .map_err(|_| RunError::NotFound)?
        {
            return Ok(message.id);
        }
    }
    let sent = crate::chat_sync::models::SendMessageRequest {
        client_message_id: id,
        kind: "text".into(),
        content,
        reply_to_message_id: reply,
        attachment_ids: vec![],
    };
    let result =
        crate::chat_sync::store::send_message_in_transaction(tx, owner, parent.conversation, sent)
            .await
            .map_err(|_| RunError::NotFound)?;
    Ok(result.value.id)
}

/// "@Name text" with the name people know, and one mention that names the
/// account or agent by id, so clients resolve it without the internal handle.
pub(super) fn addressed(name: &str, text: &str, mut mention: Value) -> (String, Vec<Value>) {
    let display = format!("@{name}");
    mention["displayText"] = json!(display);
    mention["displayLabel"] = json!(name);
    mention["startUtf16"] = json!(0);
    mention["lengthUtf16"] = json!(display.encode_utf16().count());
    (format!("{display} {text}"), vec![mention])
}

pub(super) fn person_mention(account: &str, handle: &str) -> Value {
    json!({"label":handle,"targetKind":"person","targetIdentityId":format!("human:{account}"),"humanId":account})
}

/// An agent by id; a default agent's bare name gets its owner's name.
pub(super) fn agent_address(target: &super::store::Target) -> (String, Value) {
    let name = if target.name.trim().eq_ignore_ascii_case("kordi") {
        format!("{}'s Kordi", target.owner_name)
    } else {
        target.name.clone()
    };
    let mention = json!({"label":target.handle,"targetKind":"agent","targetIdentityId":format!("agent:{}",target.agent_id),"agentId":target.agent_id,"humanId":target.owner_account_id});
    (name, mention)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addressed_text_uses_the_name_and_mentions_by_id() {
        let (text, mentions) = addressed(
            "Maya Lee",
            "Which day?",
            person_mention("acct_maya", "MayaLee2"),
        );
        assert_eq!(text, "@Maya Lee Which day?");
        assert_eq!(mentions[0]["humanId"], "acct_maya");
        assert_eq!(mentions[0]["label"], "MayaLee2");
        assert_eq!(mentions[0]["lengthUtf16"], 9);
        assert_eq!(mentions[0]["startUtf16"], 0);
        let target = super::super::store::Target {
            agent_id: "cloud-agent:acct_maya".into(),
            owner_account_id: "acct_maya".into(),
            name: "Kordi".into(),
            owner_name: "Maya Lee".into(),
            handle: "KordiMayaLee".into(),
        };
        let (name, mention) = agent_address(&target);
        assert_eq!(name, "Maya Lee's Kordi");
        assert_eq!(mention["agentId"], "cloud-agent:acct_maya");
        assert_eq!(mention["targetKind"], "agent");
    }
}
