use super::*;

pub(super) fn clean_outbox_key(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 256 {
        return Err(format!("Chat sync {label} is invalid"));
    }
    Ok(value.to_string())
}

pub(super) fn enqueue_outbox(request: ChatSyncOutboxEnqueueRequest) -> Result<(), String> {
    let account_id = clean_outbox_key(&request.account_id, "account id")?;
    let operation_id = clean_outbox_key(&request.operation_id, "operation id")?;
    let payload_json =
        serde_json::to_string(&request.payload).map_err(|error| error.to_string())?;
    if payload_json.len() > 2 * 1024 * 1024 {
        return Err("Chat sync pending operation is too large".to_string());
    }
    let conn = open_db()?;
    insert_outbox_operation(&conn, &account_id, &operation_id, &payload_json, now_ms())
}

/// Adds one pending operation. Enqueueing the same operation again, even from
/// a concurrent send, is a no-op; only a changed payload is refused.
fn insert_outbox_operation(
    conn: &Connection,
    account_id: &str,
    operation_id: &str,
    payload_json: &str,
    now: i64,
) -> Result<(), String> {
    // One statement, so two enqueues that race cannot both try to insert.
    let inserted = conn
        .execute(
            "INSERT INTO chat_sync_pending_operations
             (account_id, operation_id, operation_kind, payload_json, status,
              attempt_count, next_attempt_at_ms, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, 'send_message', ?3, 'pending', 0, 0, ?4, ?4)
             ON CONFLICT(account_id, operation_id) DO NOTHING",
            params![account_id, operation_id, payload_json, now],
        )
        .map_err(|error| error.to_string())?;
    if inserted == 1 {
        return Ok(());
    }
    let existing: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM chat_sync_pending_operations
             WHERE account_id = ?1 AND operation_id = ?2",
            params![account_id, operation_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    match existing {
        Some(existing) if existing != payload_json => {
            Err("IDEMPOTENCY_KEY_REUSED: pending operation payload changed".to_string())
        }
        _ => Ok(()),
    }
}

pub(super) fn list_due_outbox(account_id: &str) -> Result<Vec<ChatSyncPendingOperation>, String> {
    let account_id = clean_outbox_key(account_id, "account id")?;
    let conn = open_db()?;
    let mut statement = conn
        .prepare(
            "SELECT operation_id, payload_json, attempt_count, next_attempt_at_ms, last_error
             FROM chat_sync_pending_operations
             WHERE account_id = ?1 AND status = 'pending' AND next_attempt_at_ms <= ?2
             ORDER BY created_at_ms ASC LIMIT 100",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![account_id, now_ms()], |row| {
            let payload_json: String = row.get(1)?;
            let payload = serde_json::from_str(&payload_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    payload_json.len(),
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(ChatSyncPendingOperation {
                account_id: account_id.clone(),
                operation_id: row.get(0)?,
                payload,
                attempt_count: row.get(2)?,
                next_attempt_at_ms: row.get(3)?,
                last_error: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

pub(super) fn record_outbox_failure(request: ChatSyncOutboxFailureRequest) -> Result<(), String> {
    let account_id = clean_outbox_key(&request.account_id, "account id")?;
    let operation_id = clean_outbox_key(&request.operation_id, "operation id")?;
    let conn = open_db()?;
    let attempts: i64 = conn
        .query_row(
            "SELECT attempt_count FROM chat_sync_pending_operations
             WHERE account_id = ?1 AND operation_id = ?2",
            params![account_id, operation_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(0);
    let delay_ms = [1_000_i64, 2_000, 5_000, 15_000, 30_000, 60_000]
        .get(attempts.min(5) as usize)
        .copied()
        .unwrap_or(60_000);
    conn.execute(
        "UPDATE chat_sync_pending_operations
         SET status = ?1, attempt_count = attempt_count + 1,
             next_attempt_at_ms = ?2, last_error = ?3, updated_at_ms = ?4
         WHERE account_id = ?5 AND operation_id = ?6",
        params![
            if request.retryable {
                "pending"
            } else {
                "failed"
            },
            now_ms() + delay_ms,
            request.error.chars().take(1_000).collect::<String>(),
            now_ms(),
            account_id,
            operation_id,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outbox_connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE chat_sync_pending_operations (
                 account_id TEXT NOT NULL,
                 operation_id TEXT NOT NULL,
                 operation_kind TEXT NOT NULL CHECK(operation_kind IN ('send_message')),
                 payload_json TEXT NOT NULL,
                 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'failed')),
                 attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
                 next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
                 last_error TEXT,
                 created_at_ms INTEGER NOT NULL,
                 updated_at_ms INTEGER NOT NULL,
                 PRIMARY KEY(account_id, operation_id)
             );",
        )
        .unwrap();
        conn
    }

    fn count(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM chat_sync_pending_operations",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn enqueueing_the_same_operation_twice_is_a_no_op() {
        let conn = outbox_connection();
        insert_outbox_operation(&conn, "acct", "op", r#"{"body":"a"}"#, 1).unwrap();
        // A second send of the same group message, as a per-member fanout does.
        insert_outbox_operation(&conn, "acct", "op", r#"{"body":"a"}"#, 2).unwrap();
        assert_eq!(count(&conn), 1);
        let created: i64 = conn
            .query_row(
                "SELECT created_at_ms FROM chat_sync_pending_operations",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(created, 1);
    }

    #[test]
    fn a_changed_payload_for_the_same_operation_is_refused() {
        let conn = outbox_connection();
        insert_outbox_operation(&conn, "acct", "op", r#"{"body":"a"}"#, 1).unwrap();
        let error = insert_outbox_operation(&conn, "acct", "op", r#"{"body":"b"}"#, 2).unwrap_err();
        assert!(error.starts_with("IDEMPOTENCY_KEY_REUSED"), "{error}");
        assert_eq!(count(&conn), 1);
    }

    #[test]
    fn concurrent_enqueues_of_one_operation_all_succeed() {
        let path = std::env::temp_dir().join(format!(
            "kordi-outbox-race-{}-{}.sqlite",
            std::process::id(),
            now_ms()
        ));
        let setup = Connection::open(&path).unwrap();
        setup
            .execute_batch(
                "CREATE TABLE chat_sync_pending_operations (
                     account_id TEXT NOT NULL, operation_id TEXT NOT NULL,
                     operation_kind TEXT NOT NULL, payload_json TEXT NOT NULL,
                     status TEXT NOT NULL DEFAULT 'pending',
                     attempt_count INTEGER NOT NULL DEFAULT 0,
                     next_attempt_at_ms INTEGER NOT NULL DEFAULT 0, last_error TEXT,
                     created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
                     PRIMARY KEY(account_id, operation_id)
                 );",
            )
            .unwrap();
        drop(setup);
        let threads: Vec<_> = (0..8)
            .map(|index| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let conn = Connection::open(&path).unwrap();
                    conn.busy_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    insert_outbox_operation(&conn, "acct", "op", r#"{"body":"a"}"#, index)
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap().unwrap();
        }
        assert_eq!(count(&Connection::open(&path).unwrap()), 1);
        let _ = std::fs::remove_file(&path);
    }
}
