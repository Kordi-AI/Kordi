//! Rate limits on rooms. Codes are short, so entering them is limited per
//! account and per address.

use std::net::SocketAddr;

use axum::{extract::ConnectInfo, http::HeaderMap, response::Response};

use crate::auth::rate_limit::{
    rate_limit_client_key, AccountActionLimit, CloudRateLimiter, RateLimitDecision,
};
use crate::common_ground::{limited, ROOM_IP_LIMIT, ROOM_JOIN_LIMIT};

/// The per-address budget and key rooms are limited under.
pub(super) fn address_limit(
    rate_limiter: &CloudRateLimiter,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: &HeaderMap,
) -> (AccountActionLimit, String) {
    let client = crate::client_ip::resolve_client_ip(headers, connect_info.map(|info| info.0.ip()));
    let key = format!("ip:{}", rate_limit_client_key(client));
    (rate_limiter.address_limit(ROOM_IP_LIMIT, client), key)
}

/// Codes are short, so guessing is limited per account and per address.
/// Opening a room counts against both.
pub(super) async fn check_limits(
    rate_limiter: &CloudRateLimiter,
    account: &str,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: &HeaderMap,
) -> Option<Response> {
    let (ip_limit, ip_key) = address_limit(rate_limiter, connect_info, headers);
    for (limit, key) in [(ROOM_JOIN_LIMIT, account), (ip_limit, ip_key.as_str())] {
        if let RateLimitDecision::Limited { retry_after } =
            rate_limiter.observe_account_limit(limit, key).await
        {
            return Some(limited(retry_after));
        }
    }
    None
}

/// A join spends the account's budget every time, but the address's only
/// on a miss (a code with no open room, which opens one): everyone at an
/// event may share one address, and joining the right code is not a guess.
/// Once the address's budget is spent every join is refused, so hits and
/// misses still look the same. Returns the address budget to charge.
pub(super) async fn check_join_limits(
    rate_limiter: &CloudRateLimiter,
    account: &str,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: &HeaderMap,
) -> Result<(AccountActionLimit, String), Box<Response>> {
    let (ip_limit, ip_key) = address_limit(rate_limiter, connect_info, headers);
    for decision in [
        rate_limiter
            .observe_account_limit(ROOM_JOIN_LIMIT, account)
            .await,
        rate_limiter.peek_account_limit(ip_limit, &ip_key).await,
    ] {
        if let RateLimitDecision::Limited { retry_after } = decision {
            return Err(Box::new(limited(retry_after)));
        }
    }
    Ok((ip_limit, ip_key))
}
