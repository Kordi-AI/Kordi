//! Delivery and read receipts, Telegram style (issue #2455).
//!
//! No client shows another member's delivered state, so a delivery move is
//! stored and told only to the mover's own devices.
//!
//! A read move over `(r0, r1]` writes one read mark (when that member read
//! those messages, for the readers list) and raises the read watermark of
//! every other active author of a message in the range whose watermark is
//! lower. The mover's devices and each author whose watermark rose get one
//! `read_cursor.updated`; an author's copy also carries the new watermark as
//! `read_outbox`. Authors whose watermark did not rise are not told, so the
//! second reader of a group message wakes no one but themselves. Older apps
//! still draw two ticks from the reader's cursor in that event; only their
//! count of readers goes stale.

use super::support::*;
use super::*;

#[derive(Clone, Copy)]
enum CursorKind {
    Delivered,
    Read,
}

impl CursorKind {
    fn operation_kind(self) -> &'static str {
        match self {
            Self::Delivered => "conversation.delivery.advance",
            Self::Read => "conversation.read.advance",
        }
    }

    fn event_type(self) -> &'static str {
        match self {
            Self::Delivered => "delivery_cursor.updated",
            Self::Read => "read_cursor.updated",
        }
    }

    /// The `(delivered, read)` cursors after a move to `sequence`. Reading also
    /// delivers, and neither cursor moves back.
    fn advance(self, (delivered, read): (i64, i64), sequence: i64) -> (i64, i64) {
        match self {
            Self::Delivered => (delivered.max(sequence), read),
            Self::Read => (delivered.max(sequence), read.max(sequence)),
        }
    }
}

async fn advance_conversation_cursor(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    request: AdvanceConversationCursorRequest,
    kind: CursorKind,
) -> Result<ConversationCursorSnapshot, StoreError> {
    if request.sequence < 0 {
        return Err(StoreError::InvalidInput(
            "cursor sequence cannot be negative",
        ));
    }
    let request_fingerprint = fingerprint(&CursorIntent {
        conversation_id,
        sequence: request.sequence,
    })?;
    let mut transaction = pool.begin().await?;
    advisory_operation_lock(&mut transaction, account_id, request.client_operation_id).await?;
    if let Some(existing) = existing_operation::<ConversationCursorSnapshot>(
        &mut transaction,
        account_id,
        request.client_operation_id,
        kind.operation_kind(),
        &request_fingerprint,
    )
    .await?
    {
        transaction.commit().await?;
        return Ok(existing);
    }

    let latest: Option<(i64,)> = query_as(
        "SELECT latest_message_sequence FROM cloud_chat_conversations \
         WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let latest = latest.ok_or(StoreError::NotFound)?.0;
    if request.sequence > latest {
        return Err(StoreError::InvalidInput(
            "cursor sequence is beyond the conversation head",
        ));
    }
    let current: Option<(i64, i64)> = query_as(
        "SELECT last_delivered_sequence, last_read_sequence \
         FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2 AND membership_state = 'active' \
         FOR UPDATE",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(current) = current else {
        return Err(StoreError::Forbidden);
    };
    let (delivered, read) = kind.advance(current, request.sequence);
    let moved = (delivered, read) != current;
    if moved {
        query(
            "UPDATE cloud_chat_conversation_members \
             SET last_delivered_sequence = $1, last_read_sequence = $2 \
             WHERE conversation_id = $3 AND account_id = $4",
        )
        .bind(delivered)
        .bind(read)
        .bind(conversation_id)
        .bind(account_id)
        .execute(&mut *transaction)
        .await?;
    }
    let cursor = ConversationCursorSnapshot {
        conversation_id,
        account_id: account_id.to_string(),
        last_delivered_sequence: delivered,
        last_read_sequence: read,
    };
    record_operation(
        &mut transaction,
        account_id,
        request.client_operation_id,
        kind.operation_kind(),
        &request_fingerprint,
        &cursor,
    )
    .await?;
    if moved {
        let mut payloads = vec![(account_id.to_string(), json!({ "cursor": &cursor }))];
        // Server-managed accounts run no client, so their reads tell no one.
        if read > current.1 && !crate::system_account::is_service_account(account_id) {
            let raised = record_read(
                &mut transaction,
                conversation_id,
                account_id,
                (current.1, read),
            )
            .await?;
            payloads.extend(raised.into_iter().map(|(author, sequence)| {
                let read_outbox = json!({
                    "conversation_id": conversation_id,
                    "sequence": sequence,
                });
                (
                    author,
                    json!({ "cursor": &cursor, "read_outbox": read_outbox }),
                )
            }));
        }
        insert_sync_event_fanout(
            &mut transaction,
            kind.event_type(),
            Some(conversation_id),
            Some(conversation_id),
            None,
            payloads,
        )
        .await?;
    }
    transaction.commit().await?;
    Ok(cursor)
}

/// Records that `reader` read `(after, through]`: one read mark, and the read
/// watermark of every other active, non-service author of a message in that
/// range raised to their newest message there. Returns the authors whose
/// watermark rose, with its new value; nobody else is told.
///
/// The mark rides along in the same statement as a data-modifying CTE.
/// Watermark rows are upserted in account order, so reads that overlap in one
/// conversation take those row locks in the same order and cannot deadlock,
/// and no member row other than the reader's own is locked. The range is an
/// index range scan on `(conversation_id, conversation_sequence)` of
/// `cloud_chat_messages`, folded to one row per author before authors are
/// matched on the members primary key, so its cost follows the messages
/// passed, not the size of the conversation.
async fn record_read(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    reader: &str,
    (after, through): (i64, i64),
) -> Result<Vec<(String, i64)>, StoreError> {
    let raised: Vec<(String, i64)> = query_as(
        "WITH mark AS ( \
           INSERT INTO cloud_chat_read_marks \
             (conversation_id, account_id, after_sequence, through_sequence) \
           VALUES ($1, $4, $2, $3) \
           ON CONFLICT DO NOTHING \
         ), passed AS ( \
           SELECT sender_account_id, MAX(conversation_sequence) AS sequence \
           FROM cloud_chat_messages \
           WHERE conversation_id = $1 \
             AND conversation_sequence > $2 \
             AND conversation_sequence <= $3 \
             AND sender_account_id <> $4 \
           GROUP BY sender_account_id \
         ) \
         INSERT INTO cloud_chat_read_outbox AS outbox (conversation_id, account_id, sequence) \
         SELECT $1, passed.sender_account_id, passed.sequence \
         FROM passed \
         JOIN cloud_chat_conversation_members author \
           ON author.conversation_id = $1 \
          AND author.account_id = passed.sender_account_id \
         WHERE author.membership_state = 'active' \
           AND NOT (passed.sender_account_id = ANY($5)) \
         ORDER BY passed.sender_account_id ASC \
         ON CONFLICT (conversation_id, account_id) \
         DO UPDATE SET sequence = EXCLUDED.sequence \
         WHERE outbox.sequence < EXCLUDED.sequence \
         RETURNING outbox.account_id, outbox.sequence",
    )
    .bind(conversation_id)
    .bind(after)
    .bind(through)
    .bind(reader)
    .bind(crate::system_account::service_account_ids())
    .fetch_all(&mut **transaction)
    .await?;
    Ok(raised)
}

pub async fn advance_delivery_cursor(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    request: AdvanceConversationCursorRequest,
) -> Result<ConversationCursorSnapshot, StoreError> {
    advance_conversation_cursor(
        pool,
        account_id,
        conversation_id,
        request,
        CursorKind::Delivered,
    )
    .await
}

pub async fn advance_read_cursor(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    request: AdvanceConversationCursorRequest,
) -> Result<ConversationCursorSnapshot, StoreError> {
    advance_conversation_cursor(pool, account_id, conversation_id, request, CursorKind::Read).await
}

#[cfg(test)]
mod tests {
    use super::CursorKind;

    #[test]
    fn a_stale_move_changes_nothing() {
        assert_eq!(CursorKind::Delivered.advance((4, 2), 3), (4, 2));
        assert_eq!(CursorKind::Read.advance((4, 2), 2), (4, 2));
    }

    #[test]
    fn delivery_never_moves_the_read_cursor() {
        assert_eq!(CursorKind::Delivered.advance((10, 2), 12), (12, 2));
    }

    #[test]
    fn reading_behind_delivery_moves_only_the_read_cursor() {
        assert_eq!(CursorKind::Read.advance((10, 2), 6), (10, 6));
    }

    #[test]
    fn reading_past_delivery_moves_both_cursors_together() {
        assert_eq!(CursorKind::Read.advance((10, 2), 14), (14, 14));
    }
}
