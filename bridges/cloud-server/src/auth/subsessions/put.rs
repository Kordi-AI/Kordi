//! The subsession write route. Every refusal, a body the extractor rejects
//! included, is answered with a code and logged without its payload.
use super::{error, stop_reason, write_snapshot, ApiError, CloudSession, Snapshot, WriteRequest};
use crate::server::ServerState;
use axum::{
    extract::{rejection::JsonRejection, Path, State},
    Extension, Json,
};
use std::sync::Arc;
use uuid::Uuid;

pub(super) async fn write(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(id): Path<Uuid>,
    request: Result<Json<WriteRequest>, JsonRejection>,
) -> Result<Json<Snapshot>, ApiError> {
    let result = match request {
        Ok(Json(request)) => write_snapshot(&state, &session, id, request).await,
        // An unknown field or an oversized body is a refusal like any other.
        Err(rejection) => Err(error(rejection.status(), "invalid_subsession_body")),
    };
    if let Err(refusal) = &result {
        stop_reason::log_refusal(
            "PUT /v1/cloud/agent-subsessions/:id",
            id,
            &session.account_id,
            refusal,
        );
    }
    result
}
