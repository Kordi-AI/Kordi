//! Delivery and read receipts: a member's conversation cursors.
//!
//! Clients use another member's cursors only for their own outgoing messages
//! (the delivered tick, the read state, and who read a group message). For
//! incoming messages they use only the viewer's own cursor. So a cursor event
//! goes to the member who moved, whose other devices keep unread state in
//! step, and to the active authors of the messages the move passed. Everyone
//! else keeps an older copy of that member's cursors until a later move passes
//! one of their messages, or a bootstrap or conversation snapshot refreshes
//! the member list. A move in a large group therefore writes a few events
//! instead of one per member.

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
    let Some((current_delivered, current_read)) = current else {
        return Err(StoreError::Forbidden);
    };
    let (delivered, read) = match kind {
        CursorKind::Delivered => (current_delivered.max(request.sequence), current_read),
        CursorKind::Read => (
            current_delivered.max(request.sequence),
            current_read.max(request.sequence),
        ),
    };
    let passed = passed_range((current_delivered, current_read), (delivered, read));
    if passed.is_some() {
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
    if let Some(passed) = passed {
        let recipients =
            receipt_recipients(&mut transaction, conversation_id, account_id, passed).await?;
        let payload = json!({ "cursor": &cursor });
        insert_sync_event_fanout(
            &mut transaction,
            kind.event_type(),
            Some(conversation_id),
            Some(conversation_id),
            None,
            recipients
                .into_iter()
                .map(|recipient| (recipient, payload.clone()))
                .collect(),
        )
        .await?;
    }
    transaction.commit().await?;
    Ok(cursor)
}

/// The conversation sequences a cursor move passed, as `(after, through]`.
///
/// Delivery passes `(d0, d1]` and reading passes `(r0, r1]`; a range that did
/// not move is left out, and `None` means neither cursor moved. The read
/// cursor never passes the delivered one (a table constraint), and a read
/// that moves delivery moves both cursors to the same sequence, so two moved
/// ranges always end together and their hull adds no other messages.
fn passed_range(previous: (i64, i64), next: (i64, i64)) -> Option<(i64, i64)> {
    [(previous.0, next.0), (previous.1, next.1)]
        .into_iter()
        .filter(|(after, through)| through > after)
        .reduce(|left, right| (left.0.min(right.0), left.1.max(right.1)))
}

/// Who is told that `mover`'s cursor moved over `(after, through]`: the mover,
/// and every other active member who wrote a message in that range, because
/// only a message's author shows its delivered and read state. Members who
/// left are not told, nor are server-managed accounts, which run no client.
///
/// The range is an index range scan on `(conversation_id,
/// conversation_sequence)` of `cloud_chat_messages` (the history index or the
/// unique constraint), so its cost follows the messages passed, not the size
/// of the conversation. Authors are matched on the members primary key.
async fn receipt_recipients(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    mover: &str,
    (after, through): (i64, i64),
) -> Result<Vec<String>, StoreError> {
    let authors: Vec<(String,)> = query_as(
        "SELECT DISTINCT message.sender_account_id \
         FROM cloud_chat_messages message \
         JOIN cloud_chat_conversation_members author \
           ON author.conversation_id = message.conversation_id \
          AND author.account_id = message.sender_account_id \
         WHERE message.conversation_id = $1 \
           AND message.conversation_sequence > $2 \
           AND message.conversation_sequence <= $3 \
           AND message.sender_account_id <> $4 \
           AND author.membership_state = 'active'",
    )
    .bind(conversation_id)
    .bind(after)
    .bind(through)
    .bind(mover)
    .fetch_all(&mut **transaction)
    .await?;
    Ok(std::iter::once(mover.to_string())
        .chain(
            authors
                .into_iter()
                .map(|(author,)| author)
                .filter(|author| !crate::system_account::is_service_account(author)),
        )
        .collect())
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
    use super::passed_range;

    #[test]
    fn an_unchanged_cursor_passes_nothing() {
        assert_eq!(passed_range((4, 2), (4, 2)), None);
    }

    #[test]
    fn delivery_passes_only_the_newly_delivered_messages() {
        // Messages 3..=10 stay delivered but unread; their authors already
        // know, so the move passes only 11..=12.
        assert_eq!(passed_range((10, 2), (12, 2)), Some((10, 12)));
    }

    #[test]
    fn reading_behind_delivery_passes_only_the_newly_read_messages() {
        assert_eq!(passed_range((10, 2), (10, 6)), Some((2, 6)));
    }

    #[test]
    fn reading_past_delivery_passes_everything_newly_read() {
        assert_eq!(passed_range((10, 2), (14, 14)), Some((2, 14)));
    }
}
