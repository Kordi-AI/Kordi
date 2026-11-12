use super::*;
use crate::auth::session_cache::LookupSource;
use crate::auth::session_metrics::RequestKind;
use crate::organizations::requests::RequestOrganization;

pub async fn cloud_session_middleware(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    req: Request,
    next: Next,
) -> Response {
    let kind = RequestKind::from_path(req.uri().path());
    let started = std::time::Instant::now();
    let response = session_middleware(State(state.clone()), headers, req, next).await;
    state
        .session_signals()
        .lookup_cache()
        .metrics()
        .request(kind, started.elapsed());
    response
}

async fn session_middleware(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    mut req: Request,
    next: Next,
) -> Response {
    if !headers.contains_key(axum::http::header::AUTHORIZATION)
        && super::web_session_handlers::cookie_value(&headers, WEB_SESSION_COOKIE).is_some()
    {
        return super::web_session_handlers::cookie_session_middleware(
            State(state),
            headers,
            req,
            next,
        )
        .await;
    }
    let token = match bearer_token_from_headers(&headers) {
        Some(token) if token.starts_with(SESSION_TOKEN_PREFIX) => token.to_string(),
        _ => {
            return err(
                "invalid_session",
                "Missing or malformed session token.",
                StatusCode::UNAUTHORIZED,
            );
        }
    };

    let pool = state.db_pool();
    let cache = state.session_signals().lookup_cache();
    match cache.lookup(pool, &token).await {
        Ok(Some((found, source))) => {
            if let Err(error) = state.admission().authorize_facts(found.admission_facts()) {
                return error.response();
            }
            let row = found.row;
            // Cache misses perform upkeep; the expiry helper skips fixed
            // tokens and sliding sessions already inside the hourly window.
            if source == LookupSource::Database {
                let _ = bump_expiry(pool, &row, DEFAULT_SESSION_LIFETIME_DAYS).await;
                let _ = crate::auth::session::touch_device_activity_if_stale(
                    pool,
                    &row.account_id,
                    &row.device_id,
                    found.device_last_seen_at,
                )
                .await;
            }
            RequestOrganization::attach(&mut req, &row.account_id, &row.organization, &headers);
            let changes_state = !req.method().is_safe();
            let account_id = row.account_id.clone();
            req.extensions_mut().insert(CloudSession {
                token_id: row.token_id,
                account_id: row.account_id,
                device_id: row.device_id,
            });
            let response = next.run(req).await;
            // A request may have signed out, revoked a device, left an
            // organization, or deleted the account. Database signals reach
            // every replica's cache, but this one drops the caller's cached
            // sessions now, so the caller's next request sees the change.
            if changes_state {
                cache.evict_after_mutation(&account_id);
            }
            response
        }
        Ok(None) => err(
            "invalid_session",
            "Session is expired or revoked.",
            StatusCode::UNAUTHORIZED,
        ),
        Err(_) => err(
            "server_error",
            "Could not validate session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}
