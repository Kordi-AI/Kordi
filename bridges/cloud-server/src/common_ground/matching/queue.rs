//! The kinds of match run beyond a viewer's best matches: the one person
//! they opened, and a room's remaining people, matched in the background
//! so every estimated row gets a model result.

use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::store::{queue_new_matches, Queued, MATCH_BATCH};
use super::SharedCard;
use crate::auth::rate_limit::CloudRateLimiter;

/// People one background run matches once a viewer's best matches are in.
/// Larger than [`MATCH_BATCH`], so a 50-person room needs few runs each.
pub(super) const TAIL_BATCH: usize = 10;

/// What a match run is for, which sets how many people it reads and how
/// the runner leases it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Ask {
    /// The viewer's best matches, or a card's rematch.
    Best,
    /// The one person the viewer opened and waits on.
    Opened,
    /// The rest of a room, in estimate order.
    Tail,
}

impl Ask {
    pub(super) fn batch(self) -> usize {
        match self {
            Ask::Tail => TAIL_BATCH,
            Ask::Best | Ask::Opened => MATCH_BATCH,
        }
    }
}

/// Queues a run for the one person the viewer opened. The viewer waits on
/// it, so the runner leases it ahead of bulk runs queued shortly before it,
/// such as a large room's (`runs::insert_opened`).
pub(in crate::common_ground) async fn queue_opened_match(
    pool: &PgPool,
    service: &crate::system_agent::SystemAgentConfig,
    rate_limiter: &CloudRateLimiter,
    viewer: &SharedCard,
    other: &SharedCard,
    organization_id: Option<&str>,
) -> sqlx_core::Result<Queued> {
    let queued = queue_new_matches(
        pool,
        service,
        rate_limiter,
        viewer,
        std::slice::from_ref(other),
        None,
        organization_id,
        Ask::Opened,
    );
    Ok(queued.await?.0)
}

/// Queues a background run for the next [`TAIL_BATCH`] of `rest`, the room
/// members past the viewer's best matches who have no model result yet,
/// best estimate first. It waits like any other run: one per viewer at a
/// time, and people already being matched with the viewer are left out.
pub(super) async fn queue_room_tail(
    pool: &PgPool,
    service: &crate::system_agent::SystemAgentConfig,
    rate_limiter: &CloudRateLimiter,
    viewer: &SharedCard,
    rest: &[SharedCard],
    room_id: Uuid,
    organization_id: Option<&str>,
) -> sqlx_core::Result<Queued> {
    let queued = queue_new_matches(
        pool,
        service,
        rate_limiter,
        viewer,
        rest,
        Some(room_id),
        organization_id,
        Ask::Tail,
    );
    Ok(queued.await?.0)
}
