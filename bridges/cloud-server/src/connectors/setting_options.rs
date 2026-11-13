//! `GET /v1/cloud/connectors/:id/settings/options`: the choices a person can
//! pick in a connector's settings, such as the Slack channels they can see.
//!
//! Called with the owner's session from the settings screen. The credential
//! is read, refreshed, and used here on the server; only the choices
//! (`{ channels: [{ id, name, isPrivate }] }` for Slack) reach the client.
//!
//! Error codes the apps act on:
//! - `connector_scope_missing` (409): the grant predates the listing scopes.
//!   The apps show "Reconnect Slack to choose channels".
//! - `connector_not_connected` (409): the connector needs a new sign-in.
//! - `settings_options_unsupported` (404): the provider has no choices.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};

use crate::auth::routes::CloudSession;
use crate::server::ServerState;

use super::broker::load_secret;
use super::models::ConnectorStatus;
use super::providers::{ProviderError, SettingOptionsError};
use super::refresh::{refresh_if_needed, refresh_rejected};
use super::routes::{error, server_error};
use super::store;

pub const SCOPE_MISSING: &str = "connector_scope_missing";
pub const NOT_CONNECTED: &str = "connector_not_connected";
pub const UNSUPPORTED: &str = "settings_options_unsupported";

fn reconnect_message(display_name: &str) -> String {
    match display_name {
        "Slack" => "Reconnect Slack to choose channels.".to_string(),
        name => format!("Reconnect {name} to change its settings."),
    }
}

pub(super) async fn setting_options_route(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(connector_id): Path<String>,
) -> Response {
    let pool = state.db_pool();
    let runtime = state.connectors();
    let not_found = || {
        error(
            "connector_not_found",
            "Connector not found.",
            StatusCode::NOT_FOUND,
        )
    };
    let record = match store::load_account_connector(pool, &session.account_id, &connector_id).await
    {
        Ok(Some(record)) if record.status != ConnectorStatus::Revoked => record,
        Ok(_) => return not_found(),
        Err(err) => return server_error("load connector", err),
    };
    let Some(provider) = runtime.providers.get(&record.provider) else {
        return not_found();
    };
    let reconnect = reconnect_message(provider.spec().display_name);
    if record.status != ConnectorStatus::Connected {
        return error(NOT_CONNECTED, reconnect, StatusCode::CONFLICT);
    }
    let Some(cipher) = runtime.cipher.as_deref() else {
        return error(
            "connectors_unavailable",
            "Connectors are not available on this server.",
            StatusCode::SERVICE_UNAVAILABLE,
        );
    };
    let secret = match load_secret(pool, cipher, &record.connector_id).await {
        Ok(secret) => secret,
        Err(err) => {
            eprintln!("[connectors] load secret for options {connector_id}: {err}");
            return error(NOT_CONNECTED, reconnect, StatusCode::CONFLICT);
        }
    };
    let secret =
        match refresh_if_needed(pool, cipher, provider.as_ref(), &connector_id, secret).await {
            Ok(secret) => secret,
            Err(failure) => {
                eprintln!(
                    "[connectors] refresh for options {connector_id}: {}",
                    failure.audit_phrase()
                );
                return error(NOT_CONNECTED, reconnect, StatusCode::CONFLICT);
            }
        };
    let granted = &record.read_scopes;
    let mut listed = provider.setting_options(&secret, granted).await;
    if matches!(
        listed,
        Err(SettingOptionsError::Provider(ProviderError::Unauthorized))
    ) && secret.refresh_token.is_some()
    {
        // A token can be revoked or rotated before its stated expiry.
        if let Ok(refreshed) =
            refresh_rejected(pool, cipher, provider.as_ref(), &connector_id, &secret).await
        {
            listed = provider.setting_options(&refreshed, granted).await;
        }
    }
    match listed {
        Ok(options) => Json(options).into_response(),
        Err(SettingOptionsError::Unsupported) => error(
            UNSUPPORTED,
            "This connector has no settings to choose from.",
            StatusCode::NOT_FOUND,
        ),
        Err(SettingOptionsError::MissingScope) => {
            error(SCOPE_MISSING, reconnect, StatusCode::CONFLICT)
        }
        Err(SettingOptionsError::Provider(ProviderError::Unauthorized)) => {
            let _ = store::mark_needs_reauth(pool, &connector_id).await;
            error(NOT_CONNECTED, reconnect, StatusCode::CONFLICT)
        }
        Err(SettingOptionsError::Provider(err)) => {
            eprintln!("[connectors] setting options for {connector_id}: {err}");
            error(
                "provider_failed",
                format!(
                    "{} could not list the choices. Try again.",
                    provider.spec().display_name
                ),
                StatusCode::BAD_GATEWAY,
            )
        }
    }
}
