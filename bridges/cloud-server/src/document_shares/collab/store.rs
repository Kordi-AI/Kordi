//! Persistence for collaboration rooms: the compacted state, the appended
//! updates, the init grant, and the stale-revision flag.
//!
//! The update log is the source of truth shared by every server process.
//! Every writer and every compaction first locks the document's
//! `cloud_document_collab` row, so sequence numbers are assigned and
//! committed strictly in order; readers lock it `FOR SHARE` so a compaction
//! cannot delete rows between their two reads.

use chrono::{Duration, Utc};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgConnection, PgPool};

use super::relay::{update_payload, COLLAB_CHANNEL};
use super::tickets::{grants_init, InitState, INIT_GRANT_SECONDS};

/// A room as stored: the compacted state up to `seq`, then later updates.
pub(crate) struct StoredRoom {
    pub state: Vec<u8>,
    pub seq: i64,
    pub initialized: bool,
    pub updates: Vec<(i64, Vec<u8>)>,
}

/// What a room that holds every update up to some sequence must apply to
/// catch up: the compacted state when the rows it needs may be gone, then
/// the later updates in order.
pub(crate) struct StoredSince {
    pub state: Option<Vec<u8>>,
    pub compacted_seq: i64,
    pub updates: Vec<(i64, Vec<u8>)>,
}

pub(crate) async fn ensure_room_row(
    pool: &PgPool,
    attachment_id: &str,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_document_collab (attachment_id) VALUES ($1) \
         ON CONFLICT (attachment_id) DO NOTHING",
    )
    .bind(attachment_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Loads the compacted state and every later update in one consistent read.
pub(crate) async fn load_room(
    pool: &PgPool,
    attachment_id: &str,
) -> Result<StoredRoom, sqlx_core::Error> {
    ensure_room_row(pool, attachment_id).await?;
    let mut tx = pool.begin().await?;
    let (state, seq, initialized): (Vec<u8>, i64, bool) = query_as(
        "SELECT state, seq, initialized_at IS NOT NULL FROM cloud_document_collab \
         WHERE attachment_id = $1 FOR SHARE",
    )
    .bind(attachment_id)
    .fetch_one(&mut *tx)
    .await?;
    let updates = updates_after(&mut tx, attachment_id, seq).await?;
    tx.commit().await?;
    Ok(StoredRoom {
        state,
        seq,
        initialized,
        updates,
    })
}

/// What a room holding every update up to `after_seq` is missing, in one
/// consistent read. The compacted state comes along only when it covers
/// more than `after_seq`, since the rows in between may have been deleted.
pub(crate) async fn load_since(
    pool: &PgPool,
    attachment_id: &str,
    after_seq: i64,
) -> Result<StoredSince, sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    let (compacted_seq, state): (i64, Option<Vec<u8>>) = query_as(
        "SELECT seq, CASE WHEN seq > $2 THEN state END FROM cloud_document_collab \
         WHERE attachment_id = $1 FOR SHARE",
    )
    .bind(attachment_id)
    .bind(after_seq)
    .fetch_one(&mut *tx)
    .await?;
    let updates = updates_after(&mut tx, attachment_id, after_seq.max(compacted_seq)).await?;
    tx.commit().await?;
    Ok(StoredSince {
        state,
        compacted_seq,
        updates,
    })
}

async fn updates_after(
    connection: &mut PgConnection,
    attachment_id: &str,
    after_seq: i64,
) -> Result<Vec<(i64, Vec<u8>)>, sqlx_core::Error> {
    query_as(
        "SELECT seq, update FROM cloud_document_collab_updates \
         WHERE attachment_id = $1 AND seq > $2 ORDER BY seq ASC",
    )
    .bind(attachment_id)
    .bind(after_seq)
    .fetch_all(connection)
    .await
}

/// The highest stored sequence of each listed room, in one read.
pub(crate) async fn heads(
    pool: &PgPool,
    attachment_ids: &[String],
) -> Result<Vec<(String, i64)>, sqlx_core::Error> {
    query_as(
        "SELECT c.attachment_id, GREATEST(c.seq, COALESCE((SELECT MAX(u.seq) \
             FROM cloud_document_collab_updates u WHERE u.attachment_id = c.attachment_id), 0)) \
         FROM cloud_document_collab c WHERE c.attachment_id = ANY($1)",
    )
    .bind(attachment_ids)
    .fetch_all(pool)
    .await
}

/// Appends `changes` with consecutive sequence numbers in one transaction
/// and returns the first and last. The row lock orders every writer of the
/// document, across processes; the next sequence also passes rows written
/// without that lock by an older server during a rolling deploy. The first
/// stored change initializes the room and ends the grant. Other processes
/// learn of the new rows from the notification sent on commit.
pub(crate) async fn append_updates(
    pool: &PgPool,
    attachment_id: &str,
    changes: &[Vec<u8>],
    mark_initialized: bool,
) -> Result<(i64, i64), sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    let (compacted_seq,): (i64,) =
        query_as("SELECT seq FROM cloud_document_collab WHERE attachment_id = $1 FOR UPDATE")
            .bind(attachment_id)
            .fetch_one(&mut *tx)
            .await?;
    let (appended_seq,): (i64,) = query_as(
        "SELECT COALESCE(MAX(seq), 0) FROM cloud_document_collab_updates WHERE attachment_id = $1",
    )
    .bind(attachment_id)
    .fetch_one(&mut *tx)
    .await?;
    let first_seq = compacted_seq.max(appended_seq) + 1;
    let mut seq = first_seq - 1;
    for change in changes {
        seq += 1;
        query(
            "INSERT INTO cloud_document_collab_updates (attachment_id, seq, update) \
             VALUES ($1, $2, $3)",
        )
        .bind(attachment_id)
        .bind(seq)
        .bind(change)
        .execute(&mut *tx)
        .await?;
    }
    if mark_initialized {
        query(
            "UPDATE cloud_document_collab \
             SET initialized_at = now(), init_granted_to = NULL, init_grant_expires_at = NULL, \
                 updated_at = now() \
             WHERE attachment_id = $1 AND initialized_at IS NULL",
        )
        .bind(attachment_id)
        .execute(&mut *tx)
        .await?;
    }
    query("SELECT pg_notify($1, $2)")
        .bind(COLLAB_CHANNEL)
        .bind(update_payload(attachment_id, seq))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((first_seq, seq))
}

/// Replaces the stored state with `state` (covering every update up to
/// `seq`) unless the stored state already covers more, and deletes the
/// updates it covers. Any process may compact at its own sequence: its
/// document holds every update up to it, and later rows stay.
pub(crate) async fn compact(
    pool: &PgPool,
    attachment_id: &str,
    state: &[u8],
    state_vector: &[u8],
    seq: i64,
) -> Result<(), sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    query(
        "UPDATE cloud_document_collab \
         SET state = $2, state_vector = $3, seq = $4, updated_at = now() \
         WHERE attachment_id = $1 AND seq < $4",
    )
    .bind(attachment_id)
    .bind(state)
    .bind(state_vector)
    .bind(seq)
    .execute(&mut *tx)
    .await?;
    query("DELETE FROM cloud_document_collab_updates WHERE attachment_id = $1 AND seq <= $2")
        .bind(attachment_id)
        .bind(seq)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

/// Compare-and-set for the init grant (see [`grants_init`]). A new grant
/// lasts [`INIT_GRANT_SECONDS`]; the holder asking again keeps its expiry.
pub(crate) async fn take_init_grant(
    pool: &PgPool,
    attachment_id: &str,
    caller: &str,
) -> Result<bool, sqlx_core::Error> {
    ensure_room_row(pool, attachment_id).await?;
    let mut tx = pool.begin().await?;
    let (initialized, granted_to, grant_expires_at): (
        bool,
        Option<String>,
        Option<chrono::DateTime<Utc>>,
    ) = query_as(
        "SELECT initialized_at IS NOT NULL, init_granted_to, init_grant_expires_at \
             FROM cloud_document_collab WHERE attachment_id = $1 FOR UPDATE",
    )
    .bind(attachment_id)
    .fetch_one(&mut *tx)
    .await?;
    let state = InitState {
        initialized,
        granted_to,
        grant_expires_at,
    };
    let now = Utc::now();
    if !grants_init(&state, caller, now) {
        tx.rollback().await?;
        return Ok(false);
    }
    if state.granted_to.as_deref() != Some(caller)
        || state.grant_expires_at.is_none_or(|expires| expires <= now)
    {
        query(
            "UPDATE cloud_document_collab SET init_granted_to = $2, init_grant_expires_at = $3 \
             WHERE attachment_id = $1",
        )
        .bind(attachment_id)
        .bind(caller)
        .bind(now + Duration::seconds(INIT_GRANT_SECONDS))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(true)
}

/// Marks an initialized room stale after a revisioned save.
pub(crate) async fn mark_stale(pool: &PgPool, attachment_id: &str) -> Result<(), sqlx_core::Error> {
    query(
        "UPDATE cloud_document_collab SET stale_revision = TRUE \
         WHERE attachment_id = $1 AND initialized_at IS NOT NULL",
    )
    .bind(attachment_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Reads and clears the stale flag, so exactly one editor reconciles.
pub(crate) async fn take_stale_flag(
    pool: &PgPool,
    attachment_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let row: Option<(bool,)> = query_as(
        "UPDATE cloud_document_collab SET stale_revision = FALSE \
         WHERE attachment_id = $1 AND stale_revision RETURNING TRUE",
    )
    .bind(attachment_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}
