//! Closed groups (docs/development/group-closed-state.md). A closed
//! conversation keeps its members and history, so everyone can still read
//! it, but nothing new is written there. Write paths call [`require_open`],
//! which answers with the stable `group_closed` conflict code.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::StoreError;
use crate::chat_sync::models::ConversationClosed;

/// The stable error code clients read for a write to a closed group.
pub const GROUP_CLOSED_CODE: &str = "group_closed";
const GROUP_CLOSED_MESSAGE: &str = "This group was closed.";

pub(crate) fn group_closed_error() -> StoreError {
    StoreError::Conflict {
        code: GROUP_CLOSED_CODE,
        message: GROUP_CLOSED_MESSAGE,
    }
}

/// `closed` for one conversation, or `None` while it is open.
pub(super) async fn conversation_closed(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
) -> Result<Option<ConversationClosed>, StoreError> {
    Ok(closed_states(transaction, &[conversation_id])
        .await?
        .remove(&conversation_id))
}

/// `closed` for every closed conversation among `conversation_ids`.
pub(super) async fn closed_states(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_ids: &[Uuid],
) -> Result<HashMap<Uuid, ConversationClosed>, StoreError> {
    if conversation_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(Uuid, DateTime<Utc>, Option<String>)> = query_as(
        "SELECT conversation_id, closed_at, closed_by_account_id \
         FROM cloud_chat_conversations \
         WHERE conversation_id = ANY($1) AND closed_at IS NOT NULL",
    )
    .bind(conversation_ids)
    .fetch_all(&mut **transaction)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, closed_at, closed_by_account_id)| {
            (
                id,
                ConversationClosed {
                    closed_at,
                    closed_by_account_id,
                },
            )
        })
        .collect())
}

/// Refuses a write to a closed conversation with `group_closed`. A missing
/// conversation passes: the caller's own lookup answers for it.
pub(crate) async fn require_open(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
) -> Result<(), StoreError> {
    let closed: Option<(bool,)> = query_as(
        "SELECT closed_at IS NOT NULL FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .fetch_optional(&mut **transaction)
    .await?;
    match closed {
        Some((true,)) => Err(group_closed_error()),
        _ => Ok(()),
    }
}

/// Whether the conversation a session id names (its legacy session id or
/// conversation id) was closed. Agent runs, calls and other features keyed by
/// session ids use it.
pub async fn session_conversation_closed(
    pool: &PgPool,
    session_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Ok(false);
    }
    let canonical_id = Uuid::parse_str(session_id).ok();
    let closed: Option<(bool,)> = query_as(
        "SELECT closed_at IS NOT NULL FROM cloud_chat_conversations \
         WHERE legacy_session_id = $1 OR conversation_id = $2 \
         ORDER BY closed_at IS NOT NULL DESC LIMIT 1",
    )
    .bind(session_id)
    .bind(canonical_id)
    .fetch_optional(pool)
    .await?;
    Ok(closed.is_some_and(|(closed,)| closed))
}

/// Whether the conversation `conversation_id` was closed.
pub async fn conversation_is_closed(
    pool: &PgPool,
    conversation_id: Uuid,
) -> Result<bool, sqlx_core::Error> {
    let closed: Option<(bool,)> = query_as(
        "SELECT closed_at IS NOT NULL FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?;
    Ok(closed.is_some_and(|(closed,)| closed))
}

/// Whether every channel of the group space `group_space_id` (with or
/// without its `group:` prefix) was closed. A space with no conversations is
/// not closed.
pub async fn group_space_closed(
    pool: &PgPool,
    group_space_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let Some(space) = super::dissolve::normalized_space(group_space_id) else {
        return Ok(false);
    };
    let row: Option<(i64, i64)> = query_as(&format!(
        "SELECT COUNT(*), COUNT(*) FILTER (WHERE closed_at IS NOT NULL) \
         FROM cloud_chat_conversations \
         WHERE kind = 'group' AND {} = $1",
        super::dissolve::GROUP_SPACE_SQL
    ))
    .bind(space)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some_and(|(total, closed)| total > 0 && total == closed))
}
