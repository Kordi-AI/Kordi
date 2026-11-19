//! Keeping gallery items in step with the sharer's document: the title and
//! preview copied at share time are copied again when the document's text
//! or renamed title changes, so a card shows what `content` serves: the
//! stored text without the editor's block-id comments.

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::artifacts::eligible;
use super::copies::{copies, readable_text, reads_text};
use super::hints::{notify, Change};
use crate::document_shares::block_ids::reader_source;

/// Copies the title and preview of every gallery item of `attachment_id`
/// again, as a share would now, and tells the members of each room whose
/// item changed (`"item"`). Call it after a write that changes a document's
/// text or renamed title. Items stay as they are when the attachment is no
/// longer shareable or has no stored text. Best effort: a failure is logged
/// and never fails the write.
pub(crate) async fn refresh_gallery_copies(pool: &PgPool, attachment_id: &str) {
    if let Err(error) = refresh(pool, attachment_id).await {
        eprintln!("[common-ground] Could not refresh gallery items: {error}");
    }
}

async fn refresh(pool: &PgPool, attachment_id: &str) -> sqlx_core::Result<()> {
    let sharer: Option<(String,)> = query_as(
        "SELECT account_id FROM cloud_common_ground_room_gallery_items
         WHERE attachment_id = $1 LIMIT 1",
    )
    .bind(attachment_id)
    .fetch_optional(pool)
    .await?;
    let Some((sharer,)) = sharer else {
        return Ok(());
    };
    let mut tx = pool.begin().await?;
    // A save or rename that lands after this read waits for the commit, so
    // its own refresh reads the newer state and writes last.
    let stored: Option<(String,)> = query_as(
        "SELECT contents.source FROM cloud_attachments attachment
         JOIN cloud_document_contents contents ON contents.attachment_id = attachment.attachment_id
         WHERE attachment.attachment_id = $1
         FOR SHARE",
    )
    .bind(attachment_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((source,)) = stored else {
        return Ok(());
    };
    let ids = [attachment_id.to_string()];
    let Some(artifact) = eligible(&mut *tx, &sharer, Some(&ids), 1).await?.pop() else {
        return Ok(());
    };
    let text = if reads_text(&artifact) {
        readable_text(source.as_bytes()).map(reader_source)
    } else {
        None
    };
    let copies = copies(&artifact, text.as_deref());
    let changed: Vec<(Uuid, Uuid, String)> = query_as(
        "UPDATE cloud_common_ground_room_gallery_items item
         SET title = $3, preview = $4
         FROM cloud_common_ground_rooms room
         WHERE item.attachment_id = $1 AND item.account_id = $2 AND room.room_id = item.room_id
           AND (item.title IS DISTINCT FROM $3 OR item.preview IS DISTINCT FROM $4)
         RETURNING item.item_id, item.room_id, room.code",
    )
    .bind(attachment_id)
    .bind(&sharer)
    .bind(&copies.title)
    .bind(&copies.preview)
    .fetch_all(&mut *tx)
    .await?;
    // An attachment is in a room's gallery at most once.
    for (item_id, room_id, code) in changed {
        notify(&mut tx, room_id, &code, &[item_id], Change::Item, None).await?;
    }
    tx.commit().await
}
