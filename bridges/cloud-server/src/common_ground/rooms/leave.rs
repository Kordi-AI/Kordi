//! Leaving a room: on request, or from every room where a deleted card's
//! profile is shared. Leaving also deletes the member's room gallery items
//! there (see `common_ground::gallery`).

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension,
};
use sqlx_core::{query::query, query_as::query_as, transaction::Transaction};
use sqlx_postgres::Postgres;
use uuid::Uuid;

use super::{announce, my_room, room_not_found};
use crate::common_ground::{db_error, gallery};
use crate::{auth::routes::CloudSession, server::ServerState};

/// `POST /v1/cloud/common-ground/rooms/:code/leave`: leaves an open room,
/// or removes a closed one from your rooms.
pub(in crate::common_ground) async fn leave(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(code): Path<String>,
) -> Response {
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let room_id = match my_room(pool, &code, account).await {
        Ok(Some((room_id, _))) => room_id,
        Ok(None) => return room_not_found(),
        Err(error) => return db_error(error),
    };
    let result = async {
        let mut tx = pool.begin().await?;
        query(
            "UPDATE cloud_common_ground_room_members SET left_at = now()
             WHERE room_id = $1 AND account_id = $2 AND left_at IS NULL",
        )
        .bind(room_id)
        .bind(account)
        .execute(&mut *tx)
        .await?;
        gallery::forget(&mut tx, &[room_id], account).await?;
        tx.commit().await
    }
    .await;
    if let Err(error) = result {
        return db_error(error);
    }
    announce(pool, room_id).await;
    StatusCode::NO_CONTENT.into_response()
}

/// Leaves every room where `profile_id` is the shared profile and returns
/// them, for announcing.
pub(in crate::common_ground) async fn leave_profile(
    tx: &mut Transaction<'_, Postgres>,
    profile_id: &str,
) -> sqlx_core::Result<Vec<Uuid>> {
    let rows: Vec<(Uuid, String)> = query_as(
        "UPDATE cloud_common_ground_room_members SET left_at = now()
         WHERE profile_id = $1 AND left_at IS NULL RETURNING room_id, account_id",
    )
    .bind(profile_id)
    .fetch_all(&mut **tx)
    .await?;
    let rooms: Vec<Uuid> = rows.iter().map(|(room_id, _)| *room_id).collect();
    // A profile belongs to one account.
    if let Some((_, account)) = rows.first() {
        gallery::forget(tx, &rooms, account).await?;
    }
    Ok(rooms)
}
