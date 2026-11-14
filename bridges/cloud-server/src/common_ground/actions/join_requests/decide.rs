//! Approving or declining a pending request.

use super::*;

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(in crate::common_ground) struct DecideRequest {
    action: String,
}

/// `POST /v1/cloud/common-ground/join-requests/:request_id` with
/// `{ "action": "approve" | "decline" }`.
pub(in crate::common_ground) async fn decide_join_request(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(request_id): Path<String>,
    body: Option<Json<DecideRequest>>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let approve = match body
        .map(|Json(body)| body)
        .unwrap_or_default()
        .action
        .as_str()
    {
        "approve" => true,
        "decline" => false,
        _ => {
            return err(
                "common_ground_invalid_join_request",
                "Choose approve or decline.",
                StatusCode::BAD_REQUEST,
            )
        }
    };
    let request = match visible_request(pool, &request_id, viewer).await {
        Ok(request) => request,
        Err(response) => return *response,
    };
    match can_decide(pool, request.conversation_id, viewer).await {
        Ok(true) => {}
        Ok(false) => return forbidden(),
        Err(error) => return db_error(error),
    }
    if !request.pending() {
        return closed(pool, &request).await;
    }
    if approve {
        approve::approve(&state, request.request_id, viewer).await
    } else {
        decline(pool, request.request_id, viewer).await
    }
}

fn forbidden() -> Response {
    err(
        "common_ground_join_request_forbidden",
        "Only the group's admins can answer requests.",
        StatusCode::FORBIDDEN,
    )
}

/// Moves a pending request to `status`, decided by `decider`, in `tx`.
pub(super) async fn mark_decided(
    tx: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    request: &mut JoinRequest,
    status: &str,
    decider: &str,
) -> sqlx_core::Result<()> {
    query(
        "UPDATE cloud_common_ground_room_join_requests
         SET status = $2, decided_by = $3, decided_at = now(), revision = revision + 1
         WHERE request_id = $1",
    )
    .bind(request.request_id)
    .bind(status)
    .bind(decider)
    .execute(&mut **tx)
    .await?;
    request.status = status.to_string();
    request.decided_by = Some(decider.to_string());
    request.revision += 1;
    Ok(())
}

/// Locks a pending request for a decision by `decider`: the request, or the
/// response to send instead.
pub(super) async fn lock_for_decision(
    pool: &PgPool,
    tx: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    request_id: Uuid,
    decider: &str,
) -> Result<JoinRequest, Box<Response>> {
    let request = match load(&mut **tx, request_id, true).await {
        Ok(Some(request)) => request,
        Ok(None) => return Err(Box::new(request_not_found())),
        Err(error) => return Err(Box::new(db_error(error))),
    };
    if !request.pending() {
        return Err(Box::new(closed(pool, &request).await));
    }
    match can_decide(&mut **tx, request.conversation_id, decider).await {
        Ok(true) => Ok(request),
        Ok(false) => Err(Box::new(forbidden())),
        Err(error) => Err(Box::new(db_error(error))),
    }
}

async fn decline(pool: &PgPool, request_id: Uuid, decider: &str) -> Response {
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(error) => return db_error(error),
    };
    let mut request = match lock_for_decision(pool, &mut tx, request_id, decider).await {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let finished = async {
        mark_decided(&mut tx, &mut request, "declined", decider).await?;
        rooms::notify_members(&mut tx, request.room_id, &request.code).await?;
        tx.commit().await
    }
    .await;
    if let Err(error) = finished {
        return db_error(error);
    }
    sync_card(pool, &request).await;
    respond(pool, StatusCode::OK, &request).await
}
