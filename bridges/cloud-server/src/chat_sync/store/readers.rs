//! Who read one of the caller's messages: the "Seen by" list (issue #2455).
//!
//! Readers are active members other than the author, never server-managed
//! accounts, whose read cursor is at or past the message, the same people the
//! apps count. A reader's read time is the `read_at` of their read mark whose
//! range `(after_sequence, through_sequence]` holds the message. Marks are
//! pruned after seven days and did not exist before the marks table, so a
//! reader whose mark is gone has no read time rather than a later one.

use super::support::*;
use super::*;
use crate::chat_sync::models::{MessageReader, MessageReadersResponse};

/// Above this many active members the list is not offered.
const MAX_READERS_MEMBERS: i64 = MAX_GROUP_MEMBERS as i64;
const MAX_READERS_LIMIT: i64 = 100;

/// The code clients read when a conversation is too large for the list.
pub const READERS_UNAVAILABLE_CODE: &str = "readers_unavailable";

pub async fn message_readers(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    message_id: Uuid,
    limit: Option<i64>,
) -> Result<MessageReadersResponse, StoreError> {
    let limit = limit
        .unwrap_or(MAX_READERS_LIMIT)
        .clamp(1, MAX_READERS_LIMIT);
    let mut transaction = pool.begin().await?;
    query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *transaction)
        .await?;
    require_active_member(&mut transaction, conversation_id, account_id).await?;
    let service_accounts = crate::system_account::service_account_ids();
    let message: Option<(String, i64, i64)> = query_as(
        "SELECT message.sender_account_id, message.conversation_sequence, ( \
           SELECT COUNT(*) FROM cloud_chat_conversation_members member \
           WHERE member.conversation_id = message.conversation_id \
             AND member.membership_state = 'active' \
             AND NOT (member.account_id = ANY($3)) \
         ) \
         FROM cloud_chat_messages message \
         WHERE message.message_id = $1 AND message.conversation_id = $2 \
           AND message.deleted_at IS NULL",
    )
    .bind(message_id)
    .bind(conversation_id)
    .bind(&service_accounts)
    .fetch_optional(&mut *transaction)
    .await?;
    let (author, sequence, members) = message.ok_or(StoreError::NotFound)?;
    if author != account_id {
        return Err(StoreError::Forbidden);
    }
    if members > MAX_READERS_MEMBERS {
        return Err(StoreError::Conflict {
            code: READERS_UNAVAILABLE_CODE,
            message: "This group is too large to list who read a message.",
        });
    }
    let rows: Vec<(String, Option<DateTime<Utc>>, i64)> = query_as(
        "SELECT reader.account_id, \
                CASE WHEN mark.after_sequence < $3 THEN mark.read_at END AS read_at, \
                COUNT(*) OVER () \
         FROM cloud_chat_conversation_members reader \
         LEFT JOIN LATERAL ( \
           SELECT after_sequence, read_at FROM cloud_chat_read_marks \
           WHERE conversation_id = reader.conversation_id \
             AND account_id = reader.account_id \
             AND through_sequence >= $3 \
           ORDER BY through_sequence ASC \
           LIMIT 1 \
         ) mark ON TRUE \
         WHERE reader.conversation_id = $1 \
           AND reader.membership_state = 'active' \
           AND reader.account_id <> $2 \
           AND NOT (reader.account_id = ANY($4)) \
           AND reader.last_read_sequence >= $3 \
         ORDER BY read_at ASC NULLS FIRST, reader.account_id ASC \
         LIMIT $5",
    )
    .bind(conversation_id)
    .bind(account_id)
    .bind(sequence)
    .bind(&service_accounts)
    .bind(limit)
    .fetch_all(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(MessageReadersResponse {
        total: rows.first().map(|row| row.2).unwrap_or(0),
        readers: rows
            .into_iter()
            .map(|(account_id, read_at, _)| MessageReader {
                account_id,
                read_at,
            })
            .collect(),
    })
}
