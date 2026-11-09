//! Which message answers a question to a person. Only that person's own human
//! messages after the question count; their agent's messages, forwards, and
//! replies to other messages do not. A reply or quote of a question answers
//! that question; any other message answers the oldest open question before it.
//! Matching runs when the person sends a message and again in the sweep, so a
//! missed hook is recovered from durable records.
use super::*;

/// Messages read per person and conversation on each pass.
const SCAN: i64 = 50;

/// message_id, sequence, kind, content, attention content, reply-to, thread root.
type MessageRow = (Uuid, i64, String, Value, Value, Option<Uuid>, Option<Uuid>);

#[derive(Debug)]
struct Question {
    exchange: Uuid,
    sequence: i64,
    refs: Vec<String>,
}

#[derive(Debug)]
struct Reply {
    message: Uuid,
    sequence: i64,
    text: String,
    refs: Vec<String>,
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

/// The answer text of a human message from `person`, or `None` when the
/// message is not a human answer.
fn reply(person: &str, row: MessageRow) -> Option<Reply> {
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
    })
}

/// Pair answers with open questions, oldest first. Returns (exchange, reply index).
fn assign(questions: &[Question], replies: &[Reply]) -> Vec<(Uuid, usize)> {
    let mut open: Vec<&Question> = questions.iter().collect();
    open.sort_by_key(|q| q.sequence);
    let mut pairs = Vec::new();
    for (index, reply) in replies.iter().enumerate() {
        let eligible = |q: &&Question| q.sequence < reply.sequence;
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
    pairs
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
    let rows: Vec<(Uuid, i64, Uuid, Uuid)> = query_as("SELECT e.exchange_id,m.conversation_sequence,m.message_id,m.client_message_id FROM cloud_agent_exchanges e JOIN cloud_chat_messages m ON m.message_id=e.request_message_id
         WHERE e.target_kind='person' AND e.status='pending' AND e.conversation_id=$1 AND e.target_person_id=$2 AND e.deadline_at>now()
         ORDER BY m.conversation_sequence FOR UPDATE OF e")
        .bind(conversation).bind(person).fetch_all(&mut *tx).await?;
    let Some(first) = rows.first().map(|row| row.1) else {
        return Ok(0);
    };
    let questions: Vec<Question> = rows
        .into_iter()
        .map(|(exchange, sequence, message, client)| Question {
            exchange,
            sequence,
            refs: [
                message.to_string(),
                client.to_string(),
                format!("{PREFIX}{exchange}:sent"),
            ]
            .iter()
            .flat_map(|raw| reference_forms(raw))
            .collect(),
        })
        .collect();
    let messages: Vec<MessageRow> = query_as(
        "SELECT m.message_id,m.conversation_sequence,m.message_kind,m.content,COALESCE(m.attention_content,'{}'::jsonb),m.reply_to_message_id,m.thread_root_message_id FROM cloud_chat_messages m
         WHERE m.conversation_id=$1 AND m.sender_account_id=$2 AND m.conversation_sequence>$3 AND m.deleted_at IS NULL
           AND NOT EXISTS(SELECT 1 FROM cloud_agent_exchanges x WHERE x.target_kind='person' AND x.target_person_id=$2 AND x.response_message_id=m.message_id)
         ORDER BY m.conversation_sequence LIMIT $4",
    )
    .bind(conversation).bind(person).bind(first).bind(SCAN).fetch_all(&mut *tx).await?;
    let replies: Vec<Reply> = messages
        .into_iter()
        .filter_map(|row| reply(person, row))
        .collect();
    let pairs = assign(&questions, &replies);
    for (exchange, index) in &pairs {
        let reply = &replies[*index];
        query("UPDATE cloud_agent_exchanges SET status='reply_received',response_text=$2,response_message_id=$3,received_at=now() WHERE exchange_id=$1 AND status='pending'")
            .bind(exchange).bind(&reply.text).bind(reply.message).execute(&mut *tx).await?;
        progress::update(&mut tx, *exchange, "processing").await?;
    }
    tx.commit().await?;
    Ok(pairs.len())
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

    #[test]
    fn only_the_person_human_messages_are_answers() {
        assert_eq!(
            reply(
                "p",
                row(
                    5,
                    json!({"text":" Tuesday ","senderKind":"human","senderAccountId":"p"})
                )
            )
            .unwrap()
            .text,
            "Tuesday"
        );
        assert!(reply(
            "p",
            row(5, json!({"text":"Agent text","senderKind":"agent"}))
        )
        .is_none());
        assert!(reply(
            "p",
            row(5, json!({"kind":"agent-response","text":"Direct agent"}))
        )
        .is_none());
        assert!(reply("p", row(5, json!({"hidden":true}))).is_none());
        assert!(reply(
            "p",
            row(5, json!({"text":"Fwd","messageAction":{"kind":"forward"}}))
        )
        .is_none());
        assert!(reply("p", row(5, json!({"text":"Other","senderAccountId":"q"}))).is_none());
        let mut system = row(5, json!({"text":"Joined"}));
        system.2 = "system".into();
        assert!(reply("p", system).is_none());
        assert!(reply("p", row(5, json!({"text":""})))
            .unwrap()
            .text
            .contains("attachment"));
    }

    #[test]
    fn the_next_message_answers_the_oldest_open_question() {
        let questions = [question(10, "q-a"), question(4, "q-b")];
        let replies = [
            reply("p", row(3, json!({"text":"Before any question"}))).unwrap(),
            reply("p", row(6, json!({"text":"First"}))).unwrap(),
            reply("p", row(12, json!({"text":"Second"}))).unwrap(),
            reply("p", row(13, json!({"text":"Extra"}))).unwrap(),
        ];
        let pairs = assign(&questions, &replies);
        assert_eq!(
            pairs,
            vec![(questions[1].exchange, 1), (questions[0].exchange, 2)]
        );
    }

    #[test]
    fn a_quote_reply_answers_its_own_question() {
        let target = Uuid::new_v4();
        let questions = [question(4, "old"), question(8, &target.to_string())];
        let quoted = json!({"text":"Answer to the second","messageAction":{"kind":"quote","source":{"sourceMessageId":format!("collaboration-message:{target}")}}});
        let elsewhere =
            json!({"text":"About something else","replyToMessageId":Uuid::new_v4().to_string()});
        let replies = [
            reply("p", row(9, elsewhere)).unwrap(),
            reply("p", row(10, quoted)).unwrap(),
            reply("p", row(11, json!({"text":"Plain"}))).unwrap(),
        ];
        let pairs = assign(&questions, &replies);
        assert_eq!(
            pairs,
            vec![(questions[1].exchange, 1), (questions[0].exchange, 2)],
            "a reply to another message answers nothing; a quote picks its question"
        );
    }
}
