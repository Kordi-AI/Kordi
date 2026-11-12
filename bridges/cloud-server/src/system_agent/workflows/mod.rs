//! Shared cards proposed by the Facilitator. Members own every state transition.

use std::collections::BTreeSet;

use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::store::ActiveRun;
use crate::chat_sync::{models::SendMessageRequest, store as chat};
use crate::proactive;

mod routes;
pub(crate) use routes::routes;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proposal {
    kind: String,
    title: String,
    #[serde(default)]
    detail: String,
    #[serde(default)]
    options: Vec<String>,
    #[serde(default)]
    assignee_id: Option<String>,
    source_message_ids: Vec<Uuid>,
}

impl Proposal {
    fn valid(&self, input: &Value) -> bool {
        let sources: BTreeSet<_> = self.source_message_ids.iter().copied().collect();
        super::triggers::allows_workflows(input)
            && input["workflowKind"]
                .as_str()
                .is_none_or(|kind| kind == self.kind)
            && (1..=4).contains(&sources.len())
            && sources.len() == self.source_message_ids.len()
            && !self.title.trim().is_empty()
            && self.title.chars().count() <= 150
            && self.detail.chars().count() <= 600
            && super::addressing::new_human_messages(input).any(|message| {
                message["messageId"]
                    .as_str()
                    .and_then(|id| id.parse().ok())
                    .is_some_and(|id| sources.contains(&id))
            })
            && sources.iter().all(|id| {
                super::addressing::human_messages(input).any(|message| {
                    message["messageId"].as_str().and_then(|id| id.parse().ok()) == Some(*id)
                })
            })
            && match self.kind.as_str() {
                "decision" => {
                    (2..=4).contains(&self.options.len())
                        && self.options.iter().all(|option| {
                            !option.trim().is_empty() && option.chars().count() <= 100
                        })
                        && self
                            .options
                            .iter()
                            .map(|option| option.trim().to_lowercase())
                            .collect::<BTreeSet<_>>()
                            .len()
                            == self.options.len()
                }
                "memory" => !self.detail.trim().is_empty(),
                "task" => !self.detail.trim().is_empty() && self.assignee_id.is_some(),
                _ => false,
            }
    }
}

pub(super) async fn publish(
    pool: &PgPool,
    run_id: &str,
    run: &ActiveRun,
    response: &str,
) -> sqlx_core::Result<bool> {
    if !super::triggers::allows_workflows(&run.input) {
        return Ok(false);
    }
    let id = Uuid::new_v5(&Uuid::NAMESPACE_OID, run_id.as_bytes());
    if let Some(card) = Card::load(pool, id).await? {
        card.sync(pool).await?;
        return Ok(true);
    }
    let Ok(response) = serde_json::from_str::<Value>(response) else {
        return Ok(false);
    };
    let Ok(proposal) = serde_json::from_value::<Proposal>(response["workflowCard"].clone()) else {
        return Ok(false);
    };
    if !proposal.valid(&run.input) {
        return Ok(false);
    }
    let mut tx = pool.begin().await?;
    // Concurrent completion retries or discussions about the same choice share a card.
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(run.conversation_id.to_string())
        .execute(&mut *tx)
        .await?;
    let (sources,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_chat_messages message
         JOIN cloud_accounts account ON account.account_id = message.sender_account_id
         WHERE message.conversation_id = $1 AND message.message_id = ANY($2)
           AND message.deleted_at IS NULL AND account.ai_consent_status = 'allowed'",
    )
    .bind(run.conversation_id)
    .bind(&proposal.source_message_ids)
    .fetch_one(&mut *tx)
    .await?;
    if sources != proposal.source_message_ids.len() as i64 {
        return Ok(false);
    }
    let mut content =
        json!({"title": proposal.title.trim(), "sourceMessageIds": proposal.source_message_ids});
    match proposal.kind.as_str() {
        "decision" => {
            let existing: Option<(Uuid,)> = query_as(
                "SELECT card_id FROM cloud_facilitator_cards
                 WHERE conversation_id = $1 AND kind = 'decision' AND result IS NULL
                   AND lower(content->>'title') = lower($2) LIMIT 1",
            )
            .bind(run.conversation_id)
            .bind(proposal.title.trim())
            .fetch_optional(&mut *tx)
            .await?;
            if let Some((existing,)) = existing {
                tx.commit().await?;
                if let Some(card) = Card::load(pool, existing).await? {
                    card.sync(pool).await?;
                }
                return Ok(true);
            }
            content["options"] = json!(proposal
                .options
                .iter()
                .map(|option| option.trim())
                .collect::<Vec<_>>());
        }
        "task" => {
            let Some(assignee) = proposal.assignee_id.as_deref() else {
                return Ok(false);
            };
            let member: Option<(String,)> = query_as(
                "SELECT COALESCE(account.display_name, 'Member') FROM cloud_accounts account
                 JOIN cloud_chat_conversation_members member USING (account_id)
                 WHERE member.conversation_id = $1 AND member.account_id = $2
                   AND member.membership_state = 'active' AND account.ai_consent_status = 'allowed'",
            ).bind(run.conversation_id).bind(assignee).fetch_optional(&mut *tx).await?;
            let Some((assignee_name,)) = member.filter(|_| {
                assignee != run.owner_account_id
                    && assignee != crate::system_account::SYSTEM_ACCOUNT_ID
            }) else {
                return Ok(false);
            };
            let proposal_id = task_proposal_id(id);
            let inserted = query(
                "INSERT INTO cloud_agent_proactive_proposals
                 (proposal_id, agent_id, owner_account_id, conversation_id, session_id,
                  trigger_message_id, problem, offer, plan, evaluation_run_id, expires_at, facilitator_task)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, now() + interval '7 days', TRUE)
                 ON CONFLICT (evaluation_run_id) DO NOTHING",
            ).bind(&proposal_id).bind(proactive::agents::default_agent_id(assignee)).bind(assignee)
             .bind(run.conversation_id).bind(&run.session_id).bind(format!("facilitator:{id}"))
             .bind(proposal.title.trim()).bind(proposal.detail.trim()).bind(run_id)
             .execute(&mut *tx).await?;
            if inserted.rows_affected() > 0 {
                query(
                    "INSERT INTO cloud_session_tasks (task_activity_id,session_id,task_id,title,status,
                        created_by_account_id,target_account_id,participants_json,created_at,updated_at,summary)
                     VALUES ($1,$2,$1,$3,'pending',$4,$5,'[]',$6,$6,$7) ON CONFLICT DO NOTHING",
                ).bind(&proposal_id).bind(&run.session_id).bind(proposal.title.trim())
                 .bind(&run.owner_account_id).bind(assignee).bind(chrono::Utc::now().to_rfc3339())
                 .bind(proposal.detail.trim()).execute(&mut *tx).await?;
            }
            content["assigneeId"] = json!(assignee);
            content["assigneeName"] = json!(assignee_name);
            content["detail"] = json!(proposal.detail.trim());
        }
        _ => content["detail"] = json!(proposal.detail.trim()),
    }
    query("INSERT INTO cloud_facilitator_cards (card_id,run_id,conversation_id,sender_account_id,kind,content)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (run_id) DO NOTHING")
        .bind(id).bind(run_id).bind(run.conversation_id).bind(&run.owner_account_id)
        .bind(&proposal.kind).bind(&content).execute(&mut *tx).await?;
    tx.commit().await?;
    if let Some(card) = Card::load(pool, id).await? {
        card.sync(pool).await?;
    }
    Ok(true)
}

fn task_proposal_id(id: Uuid) -> String {
    format!("facilitator-task-{id}")
}

pub(crate) async fn refresh_tasks(pool: &PgPool, proposal_ids: &[String]) -> sqlx_core::Result<()> {
    let cards: Vec<Uuid> = proposal_ids
        .iter()
        .filter_map(|id| id.strip_prefix("facilitator-task-")?.parse().ok())
        .collect();
    if cards.is_empty() {
        return Ok(());
    }
    query("UPDATE cloud_facilitator_cards SET revision = revision + 1 WHERE card_id = ANY($1)")
        .bind(&cards)
        .execute(pool)
        .await?;
    for id in cards {
        if let Some(card) = Card::load(pool, id).await? {
            card.sync(pool).await?;
        }
    }
    Ok(())
}

struct Card {
    id: Uuid,
    conversation: Uuid,
    sender: String,
    kind: String,
    content: Value,
    votes: Value,
    revision: i64,
    result: Option<String>,
    message: Option<Uuid>,
}

impl Card {
    async fn load(pool: &PgPool, id: Uuid) -> sqlx_core::Result<Option<Self>> {
        let row: Option<(
            Uuid,
            String,
            String,
            Value,
            Value,
            i64,
            Option<String>,
            Option<Uuid>,
        )> = query_as(
            "SELECT conversation_id,sender_account_id,kind,content,votes,revision,result,message_id
             FROM cloud_facilitator_cards WHERE card_id = $1",
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;
        Ok(row.map(
            |(conversation, sender, kind, content, votes, revision, result, message)| Self {
                id,
                conversation,
                sender,
                kind,
                content,
                votes,
                revision,
                result,
                message,
            },
        ))
    }

    fn counts(&self) -> Vec<usize> {
        let mut counts = vec![0; self.content["options"].as_array().map_or(0, Vec::len)];
        for vote in self
            .votes
            .as_object()
            .into_iter()
            .flat_map(|votes| votes.values())
        {
            if let Some(count) = vote
                .as_u64()
                .and_then(|index| counts.get_mut(index as usize))
            {
                *count += 1;
            }
        }
        counts
    }

    async fn snapshot(&self, pool: &PgPool) -> sqlx_core::Result<Value> {
        let managers: Vec<(String,)> = query_as(
            "SELECT account_id FROM cloud_chat_conversation_members WHERE conversation_id = $1
             AND membership_state = 'active' AND role IN ('owner','admin') ORDER BY account_id",
        )
        .bind(self.conversation)
        .fetch_all(pool)
        .await?;
        let status = if self.kind == "task" {
            let row: Option<(String,)> = query_as(
                "SELECT status FROM cloud_agent_proactive_proposals WHERE proposal_id = $1",
            )
            .bind(task_proposal_id(self.id))
            .fetch_optional(pool)
            .await?;
            row.map(|(status,)| status)
        } else {
            self.result.clone()
        };
        Ok(json!({
            "type": "facilitator_card", "cardId": self.id, "kind": self.kind,
            "title": self.content["title"], "detail": self.content["detail"],
            "options": self.content["options"], "counts": self.counts(),
            "assigneeId": self.content["assigneeId"], "assigneeName": self.content["assigneeName"],
            "managerIds": managers.into_iter().map(|(id,)| id).collect::<Vec<_>>(),
            "revision": self.revision, "result": status,
        }))
    }

    async fn snapshot_for(&self, pool: &PgPool, viewer: &str) -> sqlx_core::Result<Value> {
        let mut snapshot = self.snapshot(pool).await?;
        if self.kind == "decision" {
            snapshot["myVote"] = self.votes[viewer].clone();
        }
        Ok(snapshot)
    }

    async fn sync(&self, pool: &PgPool) -> sqlx_core::Result<()> {
        let block = self.snapshot(pool).await?;
        let title = self.content["title"].as_str().unwrap_or_default();
        let detail = self.content["detail"].as_str().unwrap_or_default();
        let fallback = match self.kind.as_str() {
            "decision" => format!(
                "{title}\n{}",
                self.content["options"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" / ")
            ),
            "memory" => format!("Memory draft: {title}\n{detail}"),
            _ => format!(
                "Proposed assignment for {}: {title}\n{detail}",
                self.content["assigneeName"]
                    .as_str()
                    .unwrap_or("a group member")
            ),
        };
        if let Some(message) = self.message {
            chat::refresh_server_message_content(pool, &self.sender, message, |mut content| {
                let blocks = content["blocks"].as_array_mut()?;
                let old = blocks
                    .iter_mut()
                    .find(|item| item["type"] == "facilitator_card")?;
                if old["revision"].as_i64().unwrap_or_default() >= self.revision {
                    return None;
                }
                *old = block;
                Some(content)
            })
            .await
            .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
            return Ok(());
        }
        let outcome = chat::send_message(pool, &self.sender, self.conversation, SendMessageRequest {
            client_message_id: self.id, kind: "text".into(),
            content: json!({"schema":1, "blocks":[{"type":"text","text":fallback},block], "legacy_attachments":[]}),
            reply_to_message_id: None, attachment_ids: Vec::new(),
        }).await.map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
        query("UPDATE cloud_facilitator_cards SET message_id = $2 WHERE card_id = $1 AND message_id IS NULL")
            .bind(self.id).bind(outcome.value.id).execute(pool).await?;
        Ok(())
    }
}
