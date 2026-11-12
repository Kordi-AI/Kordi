//! A receipt must lock its conversation before taking a recipient sync head.
use super::*;
use std::time::Duration;

#[tokio::test]
async fn receipts_wait_for_conversation_writes_before_locking_sync_heads() {
    let Some(pool) = try_pool().await else { return };
    for is_read in [false, true] {
        let (conversation, [author, reader]) = group_of(&pool, ["Author", "Reader"]).await;
        let sequence = send(&pool, &author, conversation, "Synthetic lock order").await;
        let receipt_pool = sqlx_postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect_with(pool.connect_options().as_ref().clone())
            .await
            .unwrap();
        let (receipt_pid,): (i32,) = query_as("SELECT pg_backend_pid()")
            .fetch_one(&receipt_pool)
            .await
            .unwrap();
        let mut writer = pool.begin().await.unwrap();
        let (writer_pid,): (i32,) = query_as("SELECT pg_backend_pid()")
            .fetch_one(&mut *writer)
            .await
            .unwrap();
        // A group-envelope send can take this lock while updating a key column.
        query("SELECT 1 FROM cloud_chat_conversations WHERE conversation_id=$1 FOR UPDATE")
            .bind(conversation)
            .execute(&mut *writer)
            .await
            .unwrap();
        let request = cursor_request(sequence);
        let pending = {
            let reader = reader.clone();
            tokio::spawn(async move {
                if is_read {
                    store::advance_read_cursor(&receipt_pool, &reader, conversation, request).await
                } else {
                    store::advance_delivery_cursor(&receipt_pool, &reader, conversation, request)
                        .await
                }
            })
        };
        // Observe the actual database dependency rather than guessing a sleep.
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let (blocked,): (bool,) = query_as("SELECT $1 = ANY(pg_blocking_pids($2))")
                    .bind(writer_pid)
                    .bind(receipt_pid)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
                if blocked {
                    break;
                }
                assert!(!pending.is_finished(), "receipt must wait for the writer");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("receipt reaches the conversation dependency");
        // Before the fix, the receipt owned this head while waiting for its
        // event's conversation foreign-key check: the two transactions cycled.
        query("SET LOCAL lock_timeout = '500ms'")
            .execute(&mut *writer)
            .await
            .unwrap();
        query("UPDATE cloud_chat_user_sync_heads SET last_seq=last_seq WHERE account_id=$1")
            .bind(&reader)
            .execute(&mut *writer)
            .await
            .expect("a blocked receipt must not hold a sync head");
        writer.commit().await.unwrap();
        let cursor = tokio::time::timeout(Duration::from_secs(5), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(cursor.last_delivered_sequence, sequence);
        assert_eq!(
            cursor.last_read_sequence,
            if is_read { sequence } else { 0 }
        );
    }
}
