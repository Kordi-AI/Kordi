//! Which message answers a question to a person. Only that person's own human
//! messages after the question count; their agent's messages, forwards, and
//! replies to other messages do not. A reply or quote of a question answers
//! that question; any other message answers the oldest open question before it.
//! A message that asks an agent for something is a new request, routed as
//! usual, and never an answer; when the requester asks the same agent again,
//! its open question to them is superseded and cancelled.
//! Matching runs when the person sends a message and again in the sweep, so a
//! missed hook is recovered from durable records.
use super::*;
use crate::cloud_agent_runtime::runs::{
    envelopes::{CloudGroupMessage, CloudGroupParticipant},
    group_target::human_group_target,
    plain_group_request::conversation_participants,
};

/// Messages read per person and conversation on each pass.
const SCAN: i64 = 50;

/// message_id, sequence, kind, content, attention content, reply-to, thread root.
type MessageRow = (Uuid, i64, String, Value, Value, Option<Uuid>, Option<Uuid>);

#[derive(Debug)]
struct Question {
    exchange: Uuid,
    sequence: i64,
    refs: Vec<String>,
    /// The asking agent, when the question is to the person who asked it.
    requester_of: Option<String>,
}

#[derive(Debug)]
struct Reply {
    message: Uuid,
    sequence: i64,
    text: String,
    refs: Vec<String>,
    /// `Some` for a new request to an agent (the agent, when it resolves).
    request: Option<Option<String>>,
}

/// A trailing UUID also identifies a prefixed reference such as
/// `collaboration-message:<id>`.
fn reference_forms(raw: &str) -> Vec<String> {
    let raw = raw.trim();
    let mut forms = vec![raw.to_ascii_lowercase()];
    if let Some(tail) = raw.get(raw.len().saturating_sub(36)..) {
        if raw.len() > 36 && Uuid::parse_str(tail).is_ok() {
            forms.push(tail.to_ascii_lowercase());
        }
    }
    forms
}

/// Whether a human message asks an agent for something, and which agent,
/// judged as group routing judges it.
fn agent_request(
    person: &str,
    message: Uuid,
    attention: &Value,
    participants: &[CloudGroupParticipant],
) -> Option<Option<String>> {
    let named = ["targetCloudAgentId", "targetCloudAgentOwnerAccountId"]
        .iter()
        .any(|key| {
            attention[key]
                .as_str()
                .is_some_and(|v| !v.trim().is_empty())
        })
        || attention["mentions"].as_array().is_some_and(|mentions| {
            mentions.iter().any(|m| {
                matches!(
                    m["targetKind"].as_str().map(str::trim),
                    Some("agent" | "cloud-shared-agent")
                )
            })
        });
    let mut fields = attention.clone();
    if !fields.is_object() {
        return None;
    }
    fields["id"] = json!(message.to_string());
    fields["senderAccountId"] = json!(person);
    fields["createdAtMs"] = json!(0);
    if !fields["text"].is_string() {
        fields["text"] = json!("");
    }
    let target = serde_json::from_value::<CloudGroupMessage>(fields)
        .ok()
        .and_then(|m| human_group_target(&m, participants))
        .map(|t| t.agent_id);
    (named || target.is_some()).then_some(target)
}

/// The answer text of a human message from `person`, or `None` when the
/// message is not a human answer.
fn reply(person: &str, row: MessageRow, participants: &[CloudGroupParticipant]) -> Option<Reply> {
    let (message, sequence, kind, content, attention, reply_to, thread_root) = row;
    let flag = |key: &str| attention[key].as_bool() == Some(true);
    if kind == "system"
        || flag("hidden")
        || flag("synchronizationOnly")
        || attention["senderKind"] == "agent"
        || attention["kind"] == "agent-response"
        || attention["messageAction"]["kind"] == "forward"
        || attention["senderAccountId"]
            .as_str()
            .is_some_and(|sender| sender != person)
    {
        return None;
    }
    let request = agent_request(person, message, &attention, participants);
    let mut refs = Vec::new();
    for raw in [
        reply_to.map(|id| id.to_string()),
        thread_root.map(|id| id.to_string()),
        attention["replyToMessageId"].as_str().map(str::to_owned),
        attention["messageAction"]["source"]["sourceMessageId"]
            .as_str()
            .map(str::to_owned),
    ]
    .into_iter()
    .flatten()
    .filter(|raw| !raw.trim().is_empty())
    {
        refs.extend(reference_forms(&raw));
    }
    let mut text = attention["text"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_owned();
    if text.is_empty() {
        let body = crate::chat_sync::voice::body_for_agent(&content);
        if !body.starts_with("kordi-cloud-") {
            text = body.trim().to_owned();
        }
    }
    if text.is_empty() {
        text = "(The answer has no text, only an attachment.)".into();
    }
    Some(Reply {
        message,
        sequence,
        text,
        refs,
        request,
    })
}

/// Pair answers with open questions, oldest first. Returns the (exchange,
/// reply index) pairs and the questions superseded by a new request.
fn assign(questions: &[Question], replies: &[Reply]) -> (Vec<(Uuid, usize)>, Vec<Uuid>) {
    let mut open: Vec<&Question> = questions.iter().collect();
    open.sort_by_key(|q| q.sequence);
    let mut pairs = Vec::new();
    let mut superseded = Vec::new();
    for (index, reply) in replies.iter().enumerate() {
        let eligible = |q: &&Question| q.sequence < reply.sequence;
        if let Some(agent) = &reply.request {
            open.retain(|q| {
                let replaced = eligible(q) && agent.is_some() && q.requester_of == *agent;
                if replaced {
                    superseded.push(q.exchange);
                }
                !replaced
            });
            continue;
        }
        let chosen = if reply.refs.is_empty() {
            open.iter().position(eligible)
        } else {
            open.iter()
                .position(|q| eligible(q) && q.refs.iter().any(|r| reply.refs.contains(r)))
        };
        if let Some(position) = chosen {
            pairs.push((open.remove(position).exchange, index));
        }
        if open.is_empty() {
            break;
        }
    }
    (pairs, superseded)
}

/// Mark the pending questions to `person` in `conversation` that their later
/// messages answer. Idempotent and safe to run concurrently.
pub(crate) async fn match_replies(
    pool: &PgPool,
    conversation: Uuid,
    person: &str,
) -> RunResult<usize> {
    let (any,): (bool,) = query_as("SELECT EXISTS(SELECT 1 FROM cloud_agent_exchanges WHERE target_kind='person' AND status='pending' AND conversation_id=$1 AND target_person_id=$2)")
        .bind(conversation).bind(person).fetch_one(pool).await?;
    if !any {
        return Ok(0);
    }
    let mut tx = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("agent-exchange-person:{conversation}:{person}"))
        .execute(&mut *tx)
        .await?;
    let rows: Vec<(Uuid, i64, Uuid, Uuid, Option<String>)> = query_as("SELECT e.exchange_id,m.conversation_sequence,m.message_id,m.client_message_id,CASE WHEN p.requester_account_id=e.target_person_id THEN p.execution_agent_id END FROM cloud_agent_exchanges e JOIN cloud_chat_messages m ON m.message_id=e.request_message_id JOIN cloud_agent_fallback_runs p ON p.run_id=e.parent_run_id
         WHERE e.target_kind='person' AND e.status='pending' AND e.conversation_id=$1 AND e.target_person_id=$2 AND e.deadline_at>now()
         ORDER BY m.conversation_sequence FOR UPDATE OF e")
        .bind(conversation).bind(person).fetch_all(&mut *tx).await?;
    let Some(first) = rows.first().map(|row| row.1) else {
        return Ok(0);
    };
    let questions: Vec<Question> = rows
        .into_iter()
        .map(
            |(exchange, sequence, message, client, requester_of)| Question {
                exchange,
                sequence,
                requester_of,
                refs: [
                    message.to_string(),
                    client.to_string(),
                    format!("{PREFIX}{exchange}:sent"),
                ]
                .iter()
                .flat_map(|raw| reference_forms(raw))
                .collect(),
            },
        )
        .collect();
    let messages: Vec<MessageRow> = query_as(
        "SELECT m.message_id,m.conversation_sequence,m.message_kind,m.content,COALESCE(m.attention_content,'{}'::jsonb),m.reply_to_message_id,m.thread_root_message_id FROM cloud_chat_messages m
         WHERE m.conversation_id=$1 AND m.sender_account_id=$2 AND m.conversation_sequence>$3 AND m.deleted_at IS NULL
           AND NOT EXISTS(SELECT 1 FROM cloud_agent_exchanges x WHERE x.target_kind='person' AND x.target_person_id=$2 AND x.response_message_id=m.message_id)
         ORDER BY m.conversation_sequence LIMIT $4",
    )
    .bind(conversation).bind(person).bind(first).bind(SCAN).fetch_all(&mut *tx).await?;
    let participants = conversation_participants(&mut tx, conversation).await?;
    let replies: Vec<Reply> = messages
        .into_iter()
        .filter_map(|row| reply(person, row, &participants))
        .collect();
    let (pairs, superseded) = assign(&questions, &replies);
    for exchange in &superseded {
        query("UPDATE cloud_agent_exchanges SET status='cancelled',processed_at=now() WHERE exchange_id=$1 AND status='pending'")
            .bind(exchange).execute(&mut *tx).await?;
        progress::update(&mut tx, *exchange, "cancelled").await?;
    }
    for (exchange, index) in &pairs {
        let reply = &replies[*index];
        // Questions that share one asked message (a task's runs waiting on
        // the same question) all take the answer.
        let answered: Vec<(Uuid,)> = query_as("UPDATE cloud_agent_exchanges SET status='reply_received',response_text=$2,response_message_id=$3,received_at=now() WHERE status='pending' AND target_kind='person' AND (exchange_id=$1 OR request_message_id=(SELECT request_message_id FROM cloud_agent_exchanges WHERE exchange_id=$1)) RETURNING exchange_id")
            .bind(exchange).bind(&reply.text).bind(reply.message).fetch_all(&mut *tx).await?;
        for (answered,) in answered {
            progress::update(&mut tx, answered, "processing").await?;
        }
    }
    tx.commit().await?;
    Ok(pairs.len() + superseded.len())
}

/// Recovery pass over open questions to people; the reconcile sweep runs it
/// before continuations are created.
pub(super) async fn sweep(pool: &PgPool) -> RunResult<()> {
    let rows: Vec<(Uuid, String)> = query_as("SELECT DISTINCT conversation_id,target_person_id FROM cloud_agent_exchanges WHERE target_kind='person' AND status='pending' AND deadline_at>now() LIMIT 32")
        .fetch_all(pool).await?;
    for (conversation, person) in rows {
        match_replies(pool, conversation, &person).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question(sequence: i64, id: &str) -> Question {
        Question {
            exchange: Uuid::new_v4(),
            sequence,
            refs: reference_forms(id),
            requester_of: None,
        }
    }
    fn row(sequence: i64, attention: Value) -> MessageRow {
        (
            Uuid::new_v4(),
            sequence,
            "text".into(),
            json!({"blocks":[{"type":"text","text":attention["text"]}]}),
            attention,
            None,
            None,
        )
    }

    fn reply_of(row: MessageRow) -> Option<Reply> {
        reply("p", row, &[])
    }

    #[test]
    fn only_the_person_human_messages_are_answers() {
        assert_eq!(
            reply_of(row(
                5,
                json!({"text":" Tuesday ","senderKind":"human","senderAccountId":"p"})
            ))
            .unwrap()
            .text,
            "Tuesday"
        );
        assert!(reply_of(row(5, json!({"text":"Agent text","senderKind":"agent"}))).is_none());
        assert!(reply_of(row(
            5,
            json!({"kind":"agent-response","text":"Direct agent"})
        ))
        .is_none());
        assert!(reply_of(row(5, json!({"hidden":true}))).is_none());
        assert!(reply_of(row(
            5,
            json!({"text":"Fwd","messageAction":{"kind":"forward"}})
        ))
        .is_none());
        assert!(reply_of(row(5, json!({"text":"Other","senderAccountId":"q"}))).is_none());
        let mut system = row(5, json!({"text":"Joined"}));
        system.2 = "system".into();
        assert!(reply_of(system).is_none());
        assert!(reply_of(row(5, json!({"text":""})))
            .unwrap()
            .text
            .contains("attachment"));
    }

    #[test]
    fn the_next_message_answers_the_oldest_open_question() {
        let questions = [question(10, "q-a"), question(4, "q-b")];
        let replies = [
            reply_of(row(3, json!({"text":"Before any question"}))).unwrap(),
            reply_of(row(6, json!({"text":"First"}))).unwrap(),
            reply_of(row(12, json!({"text":"Second"}))).unwrap(),
            reply_of(row(13, json!({"text":"Extra"}))).unwrap(),
        ];
        let (pairs, superseded) = assign(&questions, &replies);
        assert_eq!(
            pairs,
            vec![(questions[1].exchange, 1), (questions[0].exchange, 2)]
        );
        assert!(superseded.is_empty());
    }

    #[test]
    fn a_quote_reply_answers_its_own_question() {
        let target = Uuid::new_v4();
        let questions = [question(4, "old"), question(8, &target.to_string())];
        let quoted = json!({"text":"Answer to the second","messageAction":{"kind":"quote","source":{"sourceMessageId":format!("collaboration-message:{target}")}}});
        let elsewhere =
            json!({"text":"About something else","replyToMessageId":Uuid::new_v4().to_string()});
        let replies = [
            reply_of(row(9, elsewhere)).unwrap(),
            reply_of(row(10, quoted)).unwrap(),
            reply_of(row(11, json!({"text":"Plain"}))).unwrap(),
        ];
        let (pairs, _) = assign(&questions, &replies);
        assert_eq!(
            pairs,
            vec![(questions[1].exchange, 1), (questions[0].exchange, 2)],
            "a reply to another message answers nothing; a quote picks its question"
        );
    }

    #[test]
    fn a_new_agent_request_is_not_an_answer_and_supersedes_its_agent_question() {
        let mine = "cloud-agent:p";
        let explicit = json!({"text":"Book it","targetCloudAgentId":mine,"targetCloudAgentOwnerAccountId":"p"});
        let mentioned =
            json!({"text":"@Other check","mentions":[{"targetKind":"agent","label":"Other"}]});
        assert_eq!(
            reply_of(row(5, explicit.clone())).unwrap().request,
            Some(None)
        );
        assert_eq!(
            reply_of(row(5, mentioned.clone())).unwrap().request,
            Some(None)
        );
        assert_eq!(
            reply_of(row(5, json!({"text":"Anything works"})))
                .unwrap()
                .request,
            None
        );
        let participants = [CloudGroupParticipant {
            account_id: "p".into(),
            display_name: "Pat".into(),
            avatar_url: None,
            agent_id: Some(mine.into()),
            agent_display_name: Some("Kordi".into()),
            agent_avatar_url: None,
            role: Some("person".into()),
        }];
        let resolved = reply("p", row(6, explicit), &participants).unwrap();
        assert_eq!(resolved.request, Some(Some(mine.to_string())));

        let mut to_requester = question(4, "q-a");
        to_requester.requester_of = Some(mine.into());
        let mut other_agent = question(3, "q-b");
        other_agent.requester_of = Some("cloud_agent_other".into());
        let questions = [to_requester, other_agent];
        let replies = [
            resolved,
            reply_of(row(7, mentioned)).unwrap(),
            reply_of(row(8, json!({"text":"Anything works"}))).unwrap(),
        ];
        let (pairs, superseded) = assign(&questions, &replies);
        assert_eq!(superseded, vec![questions[0].exchange]);
        assert_eq!(
            pairs,
            vec![(questions[1].exchange, 2)],
            "only the plain message answers"
        );
    }
}
