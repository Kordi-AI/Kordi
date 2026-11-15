//! Why a background session's latest request was stopped, kept in the
//! session store next to its transcript.

use anyhow::Result;

/// Custom entry type of a recorded stop reason. The entry sits on a side
/// branch, so it is never model input and never part of the transcript.
const STOP_REASON_ENTRY: &str = "background_stop_reason";

/// Records why the latest request of a background session was stopped. The
/// entry is appended as a side branch of the current leaf and the leaf is
/// restored, so the transcript and the model's history never include it.
pub fn record(session_id: &str, reason: &serde_json::Value) -> Result<()> {
    let conn = super::open_sessions_db()?;
    record_stop_reason_in_store(&conn, session_id, reason)
}

pub(super) fn record_stop_reason_in_store(
    conn: &rusqlite::Connection,
    session_id: &str,
    reason: &serde_json::Value,
) -> Result<()> {
    use kordi_core::types::{EntryBase, EntryId, SessionEntry};
    let Some(row) = kordi_session::store::get_session(conn, session_id)? else {
        return Ok(());
    };
    if row.session_scope != "runtime" {
        return Ok(());
    }
    let id = EntryId::generate();
    let entry = SessionEntry::Custom {
        base: EntryBase {
            id: id.clone(),
            parent_id: row.leaf_id.clone().map(EntryId),
            timestamp: chrono::Utc::now(),
        },
        custom_type: STOP_REASON_ENTRY.into(),
        data: Some(reason.clone()),
    };
    kordi_session::store::append_entry(conn, session_id, &entry)?;
    // Restore the leaf only if no other entry was appended meanwhile.
    conn.execute(
        "UPDATE sessions SET leaf_id=?1 WHERE session_id=?2 AND leaf_id=?3",
        rusqlite::params![row.leaf_id, session_id, id.as_str()],
    )?;
    Ok(())
}

/// The stop reason recorded after the latest request, if any.
pub(super) fn latest_stop_reason(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<serde_json::Value>> {
    use rusqlite::OptionalExtension;
    let raw: Option<String> = conn
        .query_row(
            "SELECT json_extract(payload,'$.data') FROM entries WHERE session_id=?1 AND type='custom' \
             AND json_extract(payload,'$.custom_type')=?2 AND seq > COALESCE((SELECT MAX(seq) FROM entries \
             WHERE session_id=?1 AND type='message' AND json_extract(payload,'$.message.role')='user'),0) \
             ORDER BY seq DESC LIMIT 1",
            rusqlite::params![session_id, STOP_REASON_ENTRY],
            |row| row.get(0),
        )
        .optional()?;
    Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()))
}
