//! Send transaction boundaries and optional per-request diagnostics.
use super::*;
use sqlx_core::acquire::Acquire;

pub async fn send_message(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    request: SendMessageRequest,
) -> Result<InsertOutcome<MessageSnapshot>, StoreError> {
    send_message_with_metrics(pool, account_id, conversation_id, request, None).await
}

pub(crate) async fn send_message_measured(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    request: SendMessageRequest,
    metrics: &SendTimings,
) -> Result<InsertOutcome<MessageSnapshot>, StoreError> {
    send_message_with_metrics(pool, account_id, conversation_id, request, Some(metrics)).await
}

async fn send_message_with_metrics(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    request: SendMessageRequest,
    metrics: Option<&SendTimings>,
) -> Result<InsertOutcome<MessageSnapshot>, StoreError> {
    let mut connection = measure(metrics, SendStage::PoolWait, pool.acquire()).await?;
    let mut transaction = measure(metrics, SendStage::Begin, connection.begin()).await?;
    let outcome = send_message_in_transaction_measured(
        &mut transaction,
        account_id,
        conversation_id,
        request,
        metrics,
    )
    .await?;
    measure(metrics, SendStage::Commit, transaction.commit()).await?;
    Ok(outcome)
}

pub(crate) async fn send_message_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    conversation_id: Uuid,
    request: SendMessageRequest,
) -> Result<InsertOutcome<MessageSnapshot>, StoreError> {
    send_message_in_transaction_measured(transaction, account_id, conversation_id, request, None)
        .await
}
