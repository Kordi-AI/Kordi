//! The System agent's own messages: `@Handle` mentions of people and their
//! agents resolved, and one forward action guaranteed when it steps in.

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::chat_sync::models::SendMessageRequest;
use crate::document_shares::agents::create::reply::{add_to_request, RunDocument};

use super::mentions::{encode_system_agent_message_with_mentions, render_mentions, MentionMember};

/// Triggers where the System agent steps in and must move the chat forward.
const STEP_IN_TRIGGERS: [&str; 4] = ["silence", "loop", "conflict", "stall"];

/// The conversation's members as mention targets. The System agent is
/// mentioned as a person only; it has no agent of its own to address.
async fn mention_members(
    pool: &PgPool,
    conversation_id: Uuid,
    system_agent: &str,
) -> Result<Vec<MentionMember>, sqlx_core::Error> {
    let rows: Vec<(String, String, Option<String>)> = query_as(
        "SELECT member.account_id, COALESCE(account.display_name, 'Member'), agent.display_name
         FROM cloud_chat_conversation_members member
         JOIN cloud_accounts account ON account.account_id = member.account_id
         LEFT JOIN cloud_default_agent_profiles agent
           ON agent.owner_account_id = member.account_id
         WHERE member.conversation_id = $1 AND member.membership_state = 'active'",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(account_id, display_name, agent_name)| MentionMember {
            agent_name: (account_id != system_agent
                && account_id != crate::system_account::SYSTEM_ACCOUNT_ID)
                .then_some(agent_name),
            account_id,
            display_name,
        })
        .collect())
}

/// The text a step-in run posts. A step-in must leave someone with the next
/// move: when the run published no card and its message mentions nobody, the
/// message is addressed to the trigger's `ask` mention.
pub(super) fn forward_text(
    input: &Value,
    text: &str,
    card_touched: bool,
    members: &[MentionMember],
) -> String {
    let stepping_in = input["trigger"]["kind"]
        .as_str()
        .is_some_and(|kind| STEP_IN_TRIGGERS.contains(&kind));
    let handle = input["trigger"]["ask"]["mention"].as_str();
    match handle {
        Some(handle)
            if stepping_in && !card_touched && render_mentions(text, members).1.is_empty() =>
        {
            format!("{handle} {text}")
        }
        _ => text.to_string(),
    }
}

/// Posts the System agent's words as their own message, with `@Handle`
/// mentions shown by name and resolved.
pub(super) async fn post_text(
    pool: &PgPool,
    run_id: &str,
    run: &super::store::ActiveRun,
    text: &str,
    card_touched: bool,
    documents: &[RunDocument],
) -> Result<Option<String>, sqlx_core::Error> {
    let sender = &run.owner_account_id;
    let members = mention_members(pool, run.conversation_id, sender).await?;
    let text = forward_text(&run.input, text, card_touched, &members);
    let text = super::ownership::with_step_in_line(&run.input, &text);
    let (text, mentions) = render_mentions(&text, &members);
    let mut request = SendMessageRequest {
        client_message_id: Uuid::new_v5(&Uuid::NAMESPACE_OID, format!("{run_id}:text").as_bytes()),
        kind: "text".to_string(),
        content: json!({
            "schema": 1,
            "blocks": [{"type": "text", "text": encode_system_agent_message_with_mentions(&text, mentions)}],
            "legacy_attachments": [],
        }),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    add_to_request(&mut request, documents);
    match crate::chat_sync::store::send_message(pool, sender, run.conversation_id, request).await {
        Ok(outcome) => Ok(Some(outcome.value.id.to_string())),
        Err(error) => {
            eprintln!("[system-agent] Could not post the System agent's text message: {error}");
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn members() -> Vec<MentionMember> {
        ["Bob", "Ana"]
            .into_iter()
            .map(|name| MentionMember {
                account_id: format!("acct_{name}"),
                display_name: name.to_string(),
                agent_name: Some(None),
            })
            .collect()
    }

    fn input(kind: &str) -> Value {
        json!({"trigger": {"kind": kind, "ask": {"mention": "@Bob"}}})
    }

    #[test]
    fn a_step_in_always_leaves_someone_the_next_move() {
        let members = members();
        let addressed = forward_text(&input("silence"), "Still Friday?", false, &members);
        assert_eq!(addressed, "@Bob Still Friday?");
        assert_eq!(render_mentions(&addressed, &members).1.len(), 1);
        // Its own mention of a person or an agent stands.
        for text in ["@Ana does 7 work?", "@KordiAna please decide."] {
            assert_eq!(forward_text(&input("loop"), text, false, &members), text);
        }
        // A published card is the action.
        assert_eq!(
            forward_text(&input("conflict"), "Vote is up.", true, &members),
            "Vote is up."
        );
        // Card hooks and direct requests are not step-ins.
        for kind in ["request", "card"] {
            assert_eq!(
                forward_text(&input(kind), "Done.", false, &members),
                "Done."
            );
        }
    }
}
