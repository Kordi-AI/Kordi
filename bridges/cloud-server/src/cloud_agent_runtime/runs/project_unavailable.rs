//! Ends a request that cannot run at once, with a failed reply instead of a
//! wait with no status: a project-session request no Mac with the project can
//! run (the cloud has no project files), or a person's group request whose
//! mention names no agent this claim can run.

use chrono::Utc;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::envelopes::encode_cloud_agent_response_body_with_state;
use super::{ClaimRunRequest, CloudAgentRunResponse, RunError, RunResult};
use crate::connectors::models::RunTrigger;

pub const PROJECT_UNAVAILABLE_ERROR_CODE: &str = "project_unavailable";

type RunRow = (String, String, Option<String>, String, String, String);

/// Records a failed run for the request and posts `message` as its reply.
/// Repeated calls for the same request return the first run.
pub async fn fail_unavailable_project_request(
    pool: &PgPool,
    input: &ClaimRunRequest,
    message: &str,
) -> RunResult<CloudAgentRunResponse> {
    fail_request(pool, input, message, PROJECT_UNAVAILABLE_ERROR_CODE).await
}

/// A person's group request that names no agent this claim can run (for
/// example an ambiguous or stale mention): it fails visibly instead of
/// waiting for a run that never starts.
pub async fn fail_unreachable_agent_request(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> RunResult<Option<CloudAgentRunResponse>> {
    let Some(envelope) = super::envelopes::cloud_group_request_envelope_for_run(
        pool,
        &input.session_id,
        &input.request_message_id,
    )
    .await?
    else {
        return Ok(None);
    };
    let Some(message) = envelope.message.as_ref() else {
        return Ok(None);
    };
    let owner = input.owner_account_id.trim();
    let default_agent = format!("cloud-agent:{owner}");
    // Only a person's request that names this owner's agent by id, and that
    // routing cannot take (an ambiguous or stale mention). A request routed
    // to another agent, or naming nobody, is refused without a reply, so no
    // client can post a failure as someone else's agent.
    let names_owner = message
        .target_cloud_agent_owner_account_id
        .as_deref()
        .map(str::trim)
        == Some(owner)
        || message
            .mentions
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|mention| {
                mention["targetKind"] == "agent"
                    && (["humanId", "nodeId"]
                        .iter()
                        .any(|key| mention[*key].as_str().map(str::trim) == Some(owner))
                        || mention["agentId"].as_str().map(str::trim)
                            == Some(default_agent.as_str()))
            });
    if message.sender_kind.as_deref() == Some("agent")
        || message.sender_account_id.trim() != input.requester_account_id.trim()
        || !names_owner
        || super::group_target::human_group_target(message, &envelope.participants).is_some()
    {
        return Ok(None);
    }
    let agent_id = super::execution_agent_id(pool, input).await?;
    let (agent, owner): (String, String) = query_as(
        "SELECT COALESCE((SELECT name FROM cloud_agent_definitions WHERE agent_id=$2 AND owner_account_id=$1),NULLIF(btrim(p.display_name),''),'Kordi'),COALESCE(NULLIF(btrim(a.display_name),''),'someone')
         FROM cloud_accounts a LEFT JOIN cloud_default_agent_profiles p ON p.owner_account_id=a.account_id WHERE a.account_id=$1",
    )
    .bind(&input.owner_account_id)
    .bind(&agent_id)
    .fetch_one(pool)
    .await?;
    // The agent's display name already names its owner ("Maya's Kordi");
    // only the plain default name needs the owner added.
    let name = if agent == "Kordi" {
        format!("{owner}'s Kordi")
    } else {
        agent
    };
    let message = format!("Couldn't reach {name}.");
    match fail_request(pool, input, &message, AGENT_UNREACHABLE_ERROR_CODE).await {
        Ok(run) => Ok(Some(run)),
        Err(RunError::NotFound) => Ok(None),
        Err(error) => Err(error),
    }
}

pub const AGENT_UNREACHABLE_ERROR_CODE: &str = "agent_unreachable";

/// Right after a person's group message is stored: a mention that names a
/// member's agent by id but cannot be routed ends at once with that agent's
/// failed reply, which every member sees, instead of a wait no run will end.
pub async fn fail_unroutable_mention(
    pool: &PgPool,
    conversation: Uuid,
    message: Uuid,
) -> RunResult<()> {
    let row: Option<(String, String, String)> = query_as(
        "SELECT c.legacy_session_id,m.sender_account_id,m.content #>> '{blocks,0,text}' FROM cloud_chat_messages m JOIN cloud_chat_conversations c USING(conversation_id)
         WHERE m.message_id=$1 AND m.conversation_id=$2 AND c.kind='group' AND m.deleted_at IS NULL",
    )
    .bind(message)
    .bind(conversation)
    .fetch_optional(pool)
    .await?;
    let Some((session, sender, body)) = row else {
        return Ok(());
    };
    let Some(envelope) = super::envelopes::parse_cloud_group_envelope(&body) else {
        return Ok(());
    };
    let Some(request) = envelope.message.as_ref() else {
        return Ok(());
    };
    if request.sender_kind.as_deref() == Some("agent") || request.sender_account_id.trim() != sender
    {
        return Ok(());
    }
    let mut conn = pool.acquire().await?;
    let participants =
        super::plain_group_request::conversation_participants(&mut conn, conversation).await?;
    drop(conn);
    if super::group_target::human_group_target(request, &participants).is_some() {
        return Ok(());
    }
    let named = request
        .target_cloud_agent_owner_account_id
        .clone()
        .or_else(|| {
            request
                .mentions
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find_map(|m| {
                    (m["targetKind"] == "agent")
                        .then(|| m["humanId"].as_str().map(str::to_owned))
                        .flatten()
                })
        })
        .map(|owner| owner.trim().to_owned())
        .filter(|owner| participants.iter().any(|p| p.account_id == *owner));
    let Some(owner) = named else {
        return Ok(());
    };
    let input = ClaimRunRequest {
        request_message_id: request.id.clone(),
        session_id: session,
        owner_account_id: owner.clone(),
        requester_account_id: sender,
        prompt: request.text.clone(),
        runtime_route: None,
        idempotency_key: format!("unroutable:{}:{owner}", request.id),
    };
    fail_unreachable_agent_request(pool, &input)
        .await
        .map(|_| ())
}

async fn fail_request(
    pool: &PgPool,
    input: &ClaimRunRequest,
    message: &str,
    error_code: &str,
) -> RunResult<CloudAgentRunResponse> {
    let Some((request_id, wire_id)) =
        super::request_identity(pool, &input.session_id, &input.request_message_id).await?
    else {
        return Err(RunError::NotFound);
    };
    // Only a real request from the requester in a conversation the owner is in.
    let valid: (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_chat_messages m JOIN cloud_chat_conversations c USING(conversation_id) \
         JOIN cloud_chat_conversation_members member ON member.conversation_id=c.conversation_id \
         WHERE m.message_id::text=$1 AND c.legacy_session_id=$2 AND m.sender_account_id=$3 AND m.deleted_at IS NULL \
           AND member.account_id=$4 AND member.membership_state='active')",
    )
    .bind(&wire_id)
    .bind(&input.session_id)
    .bind(&input.requester_account_id)
    .bind(&input.owner_account_id)
    .fetch_one(pool)
    .await?;
    if !valid.0 {
        return Err(RunError::NotFound);
    }
    let agent_id = super::execution_agent_id(pool, input).await?;
    let now = Utc::now().to_rfc3339();
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let inserted: Option<RunRow> = query_as(
        "INSERT INTO cloud_agent_fallback_runs (
            run_id, idempotency_key, request_message_id, session_id, owner_account_id,
            requester_account_id, status, prompt, error_code, error_message, created_at, updated_at,
            completed_at, execution_backend, execution_agent_id, run_trigger, connector_audience
         ) VALUES ($1, $2, $3, $4, $5, $6, 'failed', $7, $8, $9, $10, $10, $10, 'cloud', $11, $12, 'owner_private')
         -- Nothing runs, so the narrowest connector audience applies.
         ON CONFLICT DO NOTHING
         RETURNING run_id, status, sandbox_id, created_at, updated_at, execution_backend",
    )
    .bind(&run_id)
    .bind(&input.idempotency_key)
    .bind(&request_id)
    .bind(&input.session_id)
    .bind(&input.owner_account_id)
    .bind(&input.requester_account_id)
    .bind(&input.prompt)
    .bind(error_code)
    .bind(message)
    .bind(&now)
    .bind(&agent_id)
    .bind(RunTrigger::for_person_message(&input.owner_account_id, &input.requester_account_id).as_str())
    .fetch_optional(pool)
    .await?;
    let Some(row) = inserted else {
        // Another device ended or claimed the request first.
        let existing: Option<RunRow> = query_as(
            "SELECT run_id, status, sandbox_id, created_at, updated_at, execution_backend \
             FROM cloud_agent_fallback_runs \
             WHERE owner_account_id=$1 AND execution_agent_id=$2 AND request_message_id=$3 AND NOT legacy_duplicate",
        )
        .bind(&input.owner_account_id)
        .bind(&agent_id)
        .bind(&request_id)
        .fetch_optional(pool)
        .await?;
        return existing.map(run_response).ok_or(RunError::NotFound);
    };
    // A group reply has the same shape as any failed agent reply there.
    if error_code == AGENT_UNREACHABLE_ERROR_CODE {
        let group = super::delivery::ensure_group_response_messages(
            pool,
            super::delivery::GroupResponse {
                run_id: &row.0,
                owner_account_id: &input.owner_account_id,
                session_id: &input.session_id,
                request_message_id: &request_id,
                response_text: message,
                delivery_state: "failed",
                failure_code: Some(AGENT_UNREACHABLE_ERROR_CODE),
            },
        )
        .await?;
        if let Some(message_id) = group {
            sqlx_core::query::query(
                "UPDATE cloud_agent_fallback_runs SET response_message_id=$2 WHERE run_id=$1",
            )
            .bind(&row.0)
            .bind(&message_id)
            .execute(pool)
            .await?;
            return Ok(run_response(row));
        }
    }
    let body = encode_cloud_agent_response_body_with_state(&request_id, message, "failed");
    crate::cloud_agent_runtime::artifacts::ensure_response_message(
        pool,
        &row.0,
        &input.owner_account_id,
        &input.requester_account_id,
        &input.session_id,
        &body,
    )
    .await?;
    Ok(run_response(row))
}

fn run_response(row: RunRow) -> CloudAgentRunResponse {
    CloudAgentRunResponse {
        run_id: row.0,
        status: row.1,
        sandbox_id: row.2,
        created_at: row.3,
        updated_at: row.4,
        execution_backend: row.5,
    }
}
