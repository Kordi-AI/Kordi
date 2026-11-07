//! Removing project catalog entries of Macs that are gone.
//!
//! A removed entry only leaves the catalog: project files stay on the Mac. A
//! Mac that can still sign in publishes its catalog again when Kordi opens; one
//! without a live session is revoked so that it cannot return silently.
use super::{database_error, error, PROJECT_DEVICE_ONLINE_SECONDS};
use crate::{auth::routes::CloudSession, server::ServerState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as, transaction::Transaction};
use sqlx_postgres::{PgPool, Postgres};
use std::sync::Arc;

const LIVE_SESSION: &str = "EXISTS(SELECT 1 FROM cloud_refresh_tokens t WHERE t.device_id=$1 AND t.account_id=$2 AND t.revoked_at IS NULL AND t.expires_at::timestamptz>now())";

enum Removal {
    NotFound,
    Online,
    Removed { live_session: bool },
}

/// `DELETE /v1/cloud/projects/devices/:device_id`: the Mac's whole entry.
pub(super) async fn remove_device(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(device_id): Path<String>,
) -> Response {
    remove(state, session, device_id, None).await
}

/// `DELETE /v1/cloud/projects/devices/:device_id/projects/:project_id`: one
/// project of the Mac's entry. The entry goes when its last project does.
pub(super) async fn remove_device_project(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((device_id, project_id)): Path<(String, String)>,
) -> Response {
    remove(state, session, device_id, Some(project_id)).await
}

async fn remove(
    state: Arc<ServerState>,
    session: CloudSession,
    device_id: String,
    project_id: Option<String>,
) -> Response {
    let removal = remove_entry(
        state.db_pool(),
        &session.account_id,
        &device_id,
        project_id.as_deref(),
    )
    .await;
    let live_session = match removal {
        Ok(Removal::Removed { live_session }) => live_session,
        Ok(Removal::NotFound) => return error(StatusCode::NOT_FOUND, "Project not found."),
        Ok(Removal::Online) => {
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "errorCode": "project_device_online",
                    "message": "This Mac is online. Remove the project in Kordi on that Mac.",
                })),
            )
                .into_response()
        }
        Err(e) => return database_error(e),
    };
    let mut device_revoked = false;
    if !live_session && device_id != session.device_id {
        let response = crate::auth::routes::revoke_devices(
            state,
            session,
            uuid::Uuid::new_v4(),
            Some(device_id),
        )
        .await;
        device_revoked = response.status().is_success();
    }
    Json(json!({"ok": true, "deviceRevoked": device_revoked})).into_response()
}

async fn remove_entry(
    pool: &PgPool,
    account: &str,
    device: &str,
    project: Option<&str>,
) -> Result<Removal, sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    let row: Option<(Value, bool)> = query_as(concat!(
        "SELECT p.projects,p.updated_at>now()-make_interval(secs=>$3) FROM cloud_project_devices p \
         WHERE p.device_id=$1 AND p.account_id=$2 AND ",
        listed_project_device!(),
        " FOR UPDATE OF p",
    ))
    .bind(device)
    .bind(account)
    .bind(PROJECT_DEVICE_ONLINE_SECONDS as f64)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((projects, online)) = row else {
        return Ok(Removal::NotFound);
    };
    let mut rest = projects.as_array().cloned().unwrap_or_default();
    if let Some(project) = project {
        let before = rest.len();
        rest.retain(|entry| entry["id"].as_str() != Some(project));
        if rest.len() == before {
            return Ok(Removal::NotFound);
        }
    }
    if online {
        return Ok(Removal::Online);
    }
    let whole_entry = project.is_none() || rest.is_empty();
    if whole_entry {
        query("DELETE FROM cloud_project_devices WHERE device_id=$1 AND account_id=$2")
            .bind(device)
            .bind(account)
            .execute(&mut *tx)
            .await?;
    } else {
        // `updated_at` is kept, so the entry stays offline and keeps aging.
        query("UPDATE cloud_project_devices SET projects=$3 WHERE device_id=$1 AND account_id=$2")
            .bind(device)
            .bind(account)
            .bind(Value::Array(rest))
            .execute(&mut *tx)
            .await?;
    }
    query(
        "DELETE FROM cloud_project_commands WHERE device_id=$1 AND account_id=$2 AND status='queued' \
         AND ($3::text IS NULL OR request->>'projectId'=$3)",
    )
    .bind(device)
    .bind(account)
    .bind(if whole_entry { None } else { project })
    .execute(&mut *tx)
    .await?;
    let live: (bool,) = query_as(&format!("SELECT {LIVE_SESSION}"))
        .bind(device)
        .bind(account)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Removal::Removed {
        live_session: live.0,
    })
}

/// Sign-out: the Mac's catalog entry goes with its last live session.
pub(crate) async fn forget_signed_out_device(pool: &PgPool, account: &str, device: &str) {
    let result = query(&format!(
        "WITH gone AS (DELETE FROM cloud_project_devices WHERE device_id=$1 AND account_id=$2 AND NOT {LIVE_SESSION} RETURNING device_id) \
         DELETE FROM cloud_project_commands c USING gone WHERE c.device_id=gone.device_id AND c.status='queued'"
    ))
    .bind(device)
    .bind(account)
    .execute(pool)
    .await;
    if let Err(error) = result {
        eprintln!("[projects] Could not remove a signed-out Mac's projects: {error}");
    }
}

/// Device revocation: the revoked Macs' catalog entries and queued project
/// actions go in the same transaction.
pub(crate) async fn forget_devices(
    tx: &mut Transaction<'_, Postgres>,
    device_ids: &[String],
) -> sqlx_core::Result<()> {
    query("DELETE FROM cloud_project_commands WHERE device_id = ANY($1) AND status='queued'")
        .bind(device_ids)
        .execute(&mut **tx)
        .await?;
    query("DELETE FROM cloud_project_devices WHERE device_id = ANY($1)")
        .bind(device_ids)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
