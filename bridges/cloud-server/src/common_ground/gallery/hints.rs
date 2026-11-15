//! The `common_ground.gallery.updated` hint, and removing the items of a
//! member who leaves.

use serde_json::json;
use sqlx_core::{query_as::query_as, transaction::Transaction};
use sqlx_postgres::Postgres;
use uuid::Uuid;

/// The refresh hint every member gets when the gallery changes.
const UPDATED_HINT: &str = "common_ground.gallery.updated";

/// What a gallery hint tells clients to refetch.
#[derive(Debug, Clone, Copy)]
pub(super) enum Change {
    /// Items were shared or removed: the list.
    List,
    /// The named items changed in place (a comment was added or deleted,
    /// or the title or preview was refreshed): only those items.
    Item,
}

impl Change {
    fn as_str(self) -> &'static str {
        match self {
            Change::List => "list",
            Change::Item => "item",
        }
    }
}

/// Tells every member of the room who has not left, but `except`, that
/// these items changed, in one hint per member. Nothing for no items.
/// `itemId` is the first of `itemIds` for clients that read only it.
pub(super) async fn notify(
    tx: &mut Transaction<'_, Postgres>,
    room_id: Uuid,
    code: &str,
    item_ids: &[Uuid],
    change: Change,
    except: Option<&str>,
) -> sqlx_core::Result<()> {
    let Some(first) = item_ids.first() else {
        return Ok(());
    };
    // One order for every hint writer keeps their account locks from crossing.
    let members: Vec<(String,)> = query_as(
        "SELECT account_id FROM cloud_common_ground_room_members
         WHERE room_id = $1 AND left_at IS NULL AND ($2::text IS NULL OR account_id <> $2)
         ORDER BY account_id",
    )
    .bind(room_id)
    .bind(except)
    .fetch_all(&mut **tx)
    .await?;
    let payload = json!({
        "code": code,
        "itemId": first,
        "itemIds": item_ids,
        "change": change.as_str(),
    });
    for (account,) in members {
        crate::common_ground::hint(tx, &account, UPDATED_HINT, payload.clone()).await?;
    }
    Ok(())
}

/// Deletes `account`'s items in these rooms, which they are leaving, and
/// tells the other members of each room once. Their comments on other items
/// stay but are listed only while they are members. Call it in the
/// transaction that ends the memberships.
pub(in crate::common_ground) async fn forget(
    tx: &mut Transaction<'_, Postgres>,
    room_ids: &[Uuid],
    account: &str,
) -> sqlx_core::Result<()> {
    if room_ids.is_empty() {
        return Ok(());
    }
    let removed: Vec<(Uuid, Uuid, String)> = query_as(
        "DELETE FROM cloud_common_ground_room_gallery_items item
         USING cloud_common_ground_rooms room
         WHERE item.account_id = $1 AND item.room_id = ANY($2) AND room.room_id = item.room_id
         RETURNING item.item_id, item.room_id, room.code",
    )
    .bind(account)
    .bind(room_ids)
    .fetch_all(&mut **tx)
    .await?;
    let mut rooms: Vec<(Uuid, String, Vec<Uuid>)> = Vec::new();
    for (item_id, room_id, code) in removed {
        match rooms.iter_mut().find(|(id, _, _)| *id == room_id) {
            Some((_, _, items)) => items.push(item_id),
            None => rooms.push((room_id, code, vec![item_id])),
        }
    }
    for (room_id, code, items) in rooms {
        notify(tx, room_id, &code, &items, Change::List, Some(account)).await?;
    }
    Ok(())
}
