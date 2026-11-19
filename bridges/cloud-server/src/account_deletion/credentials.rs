//! Credentials of deleted accounts (`cloud_deleted_account_credentials`,
//! migration 0208; docs/development/account-deletion.md, "For clients").
//!
//! A deleted account's sessions and tokens go with its row, so on their own
//! they look exactly like a sign-out. The deletion transaction therefore
//! keeps the hashes of the account's live session tokens (app bearer tokens
//! and web session cookies, both `cloud_refresh_tokens` rows) and of its
//! live browser sign-in refresh tokens, each until it would have expired
//! anyway and at most [`MAX_RETENTION_DAYS`]. A rejected credential whose
//! hash is listed is answered with [`ACCOUNT_DELETED`] instead of
//! `invalid_session`, `login_required` or a bare `invalid_grant`.
//!
//! Rows hold only the hash, its kind and its expiry: no account, device,
//! email or name. A credential that was already signed out, revoked or
//! expired when the account was deleted is not listed and keeps its old
//! answer. [`spawn_sweep`] deletes expired rows.

use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use sqlx_core::query::query;
use sqlx_core::query_scalar::query_scalar;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

use crate::auth::app_sign_in::tokens::{REFRESH_REUSE_GRACE_SECS, REFRESH_TOKEN_PREFIX};
use crate::auth::session::{hash_session_token, SESSION_TOKEN_PREFIX};

/// The error code (`errorCode`) a deleted account's credential is answered
/// with, and the reason of the [`ACCOUNT_DELETED_CLOSE_CODE`] close frame.
pub const ACCOUNT_DELETED: &str = "account_deleted";
/// The message that goes with [`ACCOUNT_DELETED`].
pub const ACCOUNT_DELETED_MESSAGE: &str = "This account was deleted.";
/// The WebSocket close code of a socket closed because its account is gone.
pub const ACCOUNT_DELETED_CLOSE_CODE: u16 = 4410;
/// The longest a hash is kept, whatever its credential's expiry.
pub const MAX_RETENTION_DAYS: i32 = 30;
/// How often expired hashes are deleted.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// The kind of a listed credential.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialKind {
    /// A `kordi_cs_` session token: an app bearer token, a browser sign-in
    /// access token, or a web session cookie.
    Session,
    /// A `kordi_rt_` browser sign-in refresh token.
    Refresh,
}

impl CredentialKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Refresh => "refresh",
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            Self::Session => SESSION_TOKEN_PREFIX,
            Self::Refresh => REFRESH_TOKEN_PREFIX,
        }
    }
}

/// What [`record_in_transaction`] listed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Recorded {
    pub sessions: u64,
    pub refresh_tokens: u64,
}

/// Lists the hashes of `account_id`'s live credentials in `tx`, before the
/// account row and its credentials are deleted. Only credentials that still
/// work are listed: an unrevoked, unexpired session on an authorized device,
/// and an unexpired refresh token of an unrevoked browser sign-in that was
/// not rotated, or was rotated within the reuse grace period. Each row
/// expires with its credential, at most [`MAX_RETENTION_DAYS`] from now.
pub async fn record_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<Recorded, sqlx_core::Error> {
    // `cloud_refresh_tokens.expires_at` is RFC 3339 text; the conditions
    // match `crate::auth::session::lookup_session_by_hash`.
    let sessions = query(
        "INSERT INTO cloud_deleted_account_credentials (credential_hash, kind, expires_at) \
         SELECT token.token_hash, 'session', \
                LEAST(token.expires_at::timestamptz, now() + make_interval(days => $2)) \
         FROM cloud_refresh_tokens token \
         JOIN cloud_devices device ON device.device_id = token.device_id \
         WHERE token.account_id = $1 AND token.revoked_at IS NULL \
           AND token.expires_at::timestamptz > now() \
           AND device.account_id = token.account_id AND device.revoked_at IS NULL \
         ON CONFLICT (credential_hash) DO NOTHING",
    )
    .bind(account_id)
    .bind(MAX_RETENTION_DAYS)
    .execute(&mut **tx)
    .await?
    .rows_affected();
    // The conditions match `crate::auth::app_sign_in::tokens::rotate_refresh_token`.
    let refresh_tokens = query(
        "INSERT INTO cloud_deleted_account_credentials (credential_hash, kind, expires_at) \
         SELECT token.token_hash, 'refresh', \
                LEAST(token.expires_at, now() + make_interval(days => $2)) \
         FROM cloud_app_refresh_tokens token \
         JOIN cloud_app_sign_ins sign_in ON sign_in.sign_in_id = token.sign_in_id \
         JOIN cloud_devices device ON device.device_id = sign_in.device_id \
         WHERE sign_in.account_id = $1 AND sign_in.revoked_at IS NULL \
           AND token.expires_at > now() \
           AND (token.rotated_at IS NULL \
                OR token.rotated_at > now() - make_interval(secs => $3)) \
           AND device.revoked_at IS NULL \
           AND NOT COALESCE(device.last_revoked_at >= sign_in.created_at, FALSE) \
         ON CONFLICT (credential_hash) DO NOTHING",
    )
    .bind(account_id)
    .bind(MAX_RETENTION_DAYS)
    .bind(REFRESH_REUSE_GRACE_SECS as f64)
    .execute(&mut **tx)
    .await?
    .rows_affected();
    Ok(Recorded {
        sessions,
        refresh_tokens,
    })
}

/// Whether the plaintext credential `token` of `kind` belonged to an account
/// that was deleted while it still worked. A database error counts as no,
/// so the caller keeps its usual answer.
pub async fn was_deleted(pool: &PgPool, kind: CredentialKind, token: &str) -> bool {
    if !token.starts_with(kind.prefix()) {
        return false;
    }
    // Session and refresh token hashes are both a hex SHA-256 of the
    // plaintext.
    let hash = hash_session_token(token);
    query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM cloud_deleted_account_credentials \
         WHERE credential_hash = $1 AND kind = $2 AND expires_at > now())",
    )
    .bind(hash)
    .bind(kind.as_str())
    .fetch_one(pool)
    .await
    .unwrap_or(false)
}

/// Deletes the hashes whose credentials would have expired by now. Returns
/// how many were deleted.
pub async fn sweep(pool: &PgPool) -> Result<u64, sqlx_core::Error> {
    Ok(
        query("DELETE FROM cloud_deleted_account_credentials WHERE expires_at <= now()")
            .execute(pool)
            .await?
            .rows_affected(),
    )
}

/// Starts the hourly [`sweep`].
pub fn spawn_sweep(pool: PgPool) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;
            if let Err(error) = sweep(&pool).await {
                eprintln!("[account-deletion] Could not sweep deleted credentials: {error}");
            }
        }
    });
}

/// `401` with `errorCode: "account_deleted"`, in the envelope of the other
/// bearer-token errors.
pub fn account_deleted_response() -> Response {
    crate::auth::routes::err(
        ACCOUNT_DELETED,
        ACCOUNT_DELETED_MESSAGE,
        StatusCode::UNAUTHORIZED,
    )
}

/// The `invalid_grant` answer to a deleted account's refresh token: the
/// OAuth error stays `invalid_grant`, and `errorCode` says why.
pub fn account_deleted_grant_response() -> Response {
    let mut response = (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({
            "error": "invalid_grant",
            "error_description": ACCOUNT_DELETED_MESSAGE,
            "errorCode": ACCOUNT_DELETED,
            "message": ACCOUNT_DELETED_MESSAGE,
        })),
    )
        .into_response();
    let headers = response.headers_mut();
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    headers.insert(
        axum::http::header::PRAGMA,
        axum::http::HeaderValue::from_static("no-cache"),
    );
    response
}

/// The close frame of a socket closed because its account is gone.
pub fn account_deleted_close_frame() -> CloseFrame<'static> {
    CloseFrame {
        code: ACCOUNT_DELETED_CLOSE_CODE,
        reason: ACCOUNT_DELETED.into(),
    }
}

/// Whether `account_id` no longer exists. A socket that ends because its
/// session or device is gone asks this to choose its close frame. A database
/// error counts as no.
pub async fn account_is_gone(pool: &PgPool, account_id: &str) -> bool {
    query_scalar::<_, bool>(
        "SELECT NOT EXISTS (SELECT 1 FROM cloud_accounts WHERE account_id = $1)",
    )
    .bind(account_id)
    .fetch_one(pool)
    .await
    .unwrap_or(false)
}

/// The close message for a socket whose session ended: [`ACCOUNT_DELETED_CLOSE_CODE`]
/// when the account is gone, otherwise a close without a code as before.
pub async fn session_ended_close(pool: &PgPool, account_id: &str) -> Message {
    if account_is_gone(pool, account_id).await {
        Message::Close(Some(account_deleted_close_frame()))
    } else {
        Message::Close(None)
    }
}
