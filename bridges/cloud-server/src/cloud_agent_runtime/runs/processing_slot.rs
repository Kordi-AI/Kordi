//! A person's request that the cloud runner takes shows its agent's reply
//! slot as processing right away, as the owner's Mac does (#2416); the
//! completion then replaces that same row with the answer.
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::delivery::{
    ensure_group_response_messages, ensure_scheduled_direct_person_response_message,
    is_scheduled_run_request_id, GroupResponse,
};
use super::envelopes::encode_cloud_agent_response_body_with_state;
use super::RunResult;

/// `yielding`: the run is a person's chat run that yields to wait right now,
/// so its slot is created in progress before it shows whom it waits for.
pub(super) async fn show(pool: &PgPool, run_id: &str, yielding: bool) -> RunResult<()> {
    // Only a chat request's run (`car_`); exchange runs have their own rows,
    // and feature and scheduled runs post their own replies.
    let row: Option<(String, String, String)> = query_as(
        "SELECT owner_account_id,session_id,request_message_id FROM cloud_agent_fallback_runs \
         WHERE run_id=$1 AND ($2 OR (execution_backend='cloud' AND starts_with(run_id,'car_') \
           AND NOT starts_with(run_id,'car_exchange_'))) AND subsession_id IS NULL \
           AND response_message_id IS NULL AND NOT starts_with(request_message_id,'agent-exchange:')",
    )
    .bind(run_id)
    .bind(yielding)
    .fetch_optional(pool)
    .await?;
    let Some((owner, session, request)) = row else {
        return Ok(());
    };
    if is_scheduled_run_request_id(&request) {
        return Ok(());
    }
    let group = GroupResponse {
        run_id,
        owner_account_id: &owner,
        session_id: &session,
        request_message_id: &request,
        response_text: "",
        delivery_state: "processing",
        failure_code: None,
    };
    if ensure_group_response_messages(pool, group).await?.is_none() {
        let body = encode_cloud_agent_response_body_with_state(&request, "", "processing");
        ensure_scheduled_direct_person_response_message(pool, run_id, &owner, &session, &body)
            .await?;
    }
    Ok(())
}
