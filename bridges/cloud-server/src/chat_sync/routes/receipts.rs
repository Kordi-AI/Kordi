//! Delivery and read cursors, and who read one of the caller's messages.

use super::*;
use crate::chat_sync::models::{AdvanceConversationCursorRequest, CursorResponse, ReadersQuery};

pub(super) async fn advance_delivery_cursor(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(conversation_id): Path<Uuid>,
    Json(request): Json<AdvanceConversationCursorRequest>,
) -> Response {
    match store::advance_delivery_cursor(
        state.db_pool(),
        &session.account_id,
        conversation_id,
        request,
    )
    .await
    {
        Ok(cursor) => Json(CursorResponse { cursor }).into_response(),
        Err(error) => store_error("advance delivery cursor", error),
    }
}

pub(super) async fn advance_read_cursor(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(conversation_id): Path<Uuid>,
    Json(request): Json<AdvanceConversationCursorRequest>,
) -> Response {
    match store::advance_read_cursor(
        state.db_pool(),
        &session.account_id,
        conversation_id,
        request,
    )
    .await
    {
        Ok(cursor) => Json(CursorResponse { cursor }).into_response(),
        Err(error) => store_error("advance read cursor", error),
    }
}

/// `GET .../messages/:message_id/readers?limit=N`: the "Seen by" list, for the
/// message's author only.
pub(super) async fn readers(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((conversation_id, message_id)): Path<(Uuid, Uuid)>,
    Query(request): Query<ReadersQuery>,
) -> Response {
    match store::message_readers(
        state.db_pool(),
        &session.account_id,
        conversation_id,
        message_id,
        request.limit,
    )
    .await
    {
        Ok(readers) => Json(readers).into_response(),
        Err(error) => store_error("load message readers", error),
    }
}
