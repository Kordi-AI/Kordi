//! Matching again after a card changed. A manual build or an automatic
//! update that changes a card marks it (`cloud_common_ground_cards.rematch_at`).
//! The automatic-update sweep then queues one match run for up to
//! [`MATCH_BATCH`] people the card already had a match with, whose match is
//! no longer current and who are still linked to it through a pairing or an
//! open room: most recently opened first, then most recently computed.
//! Other stale matches refresh when someone opens them. Claims use `SKIP
//! LOCKED` and push the mark a minute out, so sweeps on several servers
//! never take the same card, and a card waiting on a run looks again later.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::shared_cards;
use super::store::{queue_new_matches, Pending, Queued, MATCH_BATCH};
use crate::auth::rate_limit::CloudRateLimiter;
use crate::common_ground::{people, ROOM_OPEN_SQL};

/// Marked cards one sweep looks at.
const BATCH: i64 = 20;
/// Stale matches read per card; the first [`MATCH_BATCH`] still linked are
/// matched.
const CANDIDATES: i64 = 100;

/// What happened to one marked card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::common_ground) enum Rematch {
    /// One match run was queued and the mark cleared.
    Queued,
    /// A run for this profile is at work, or other people's open runs cover
    /// it: the mark stays and the card is looked at again in a minute.
    Waiting,
    /// Nothing to match, or no run may be queued: the mark was cleared.
    Cleared,
}

struct Marked {
    profile_id: String,
    account_id: String,
    /// The card is built and shared.
    shared: bool,
    /// The mark as claimed; a newer one is never cleared.
    claimed: DateTime<Utc>,
}

async fn claim(pool: &PgPool) -> sqlx_core::Result<Vec<Marked>> {
    let rows: Vec<(String, String, bool, DateTime<Utc>)> = query_as(
        "UPDATE cloud_common_ground_cards card SET rematch_at = now() + interval '1 minute'
         FROM (SELECT c.profile_id FROM cloud_common_ground_cards c
               WHERE c.rematch_at <= now()
               ORDER BY c.rematch_at LIMIT $1 FOR UPDATE SKIP LOCKED) picked
         WHERE card.profile_id = picked.profile_id
         RETURNING card.profile_id, card.account_id,
             card.built_at IS NOT NULL AND card.sharing_enabled, card.rematch_at",
    )
    .bind(BATCH)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(profile_id, account_id, shared, claimed)| Marked {
            profile_id,
            account_id,
            shared,
            claimed,
        })
        .collect())
}

/// Handles marked cards, oldest mark first. A card's failure is logged and
/// does not hold up the others; its mark stays for a later sweep.
pub(in crate::common_ground) async fn rematch(
    pool: &PgPool,
    service: &crate::system_agent::SystemAgentConfig,
    rate_limiter: &CloudRateLimiter,
) -> sqlx_core::Result<Vec<(String, Rematch)>> {
    let mut outcomes = Vec::new();
    for marked in claim(pool).await? {
        match one(pool, service, rate_limiter, &marked).await {
            Ok(outcome) => outcomes.push((marked.profile_id, outcome)),
            Err(error) => {
                eprintln!("[common-ground] Matching again failed for one card: {error}")
            }
        }
    }
    Ok(outcomes)
}

/// Queues the card's one run, in the owner's personal pool. The owner did
/// not ask, so they must have allowed AI for background work.
async fn one(
    pool: &PgPool,
    service: &crate::system_agent::SystemAgentConfig,
    rate_limiter: &CloudRateLimiter,
    marked: &Marked,
) -> sqlx_core::Result<Rematch> {
    if !marked.shared || !crate::ai_consent::is_allowed(pool, &marked.account_id).await? {
        return clear(pool, marked).await;
    }
    let mut members = vec![(marked.account_id.clone(), marked.profile_id.clone())];
    members.extend(partners(pool, &marked.account_id, &marked.profile_id).await?);
    let cards = shared_cards(pool, &members).await?;
    let Some((viewer, others)) = cards.split_first() else {
        return clear(pool, marked).await;
    };
    if viewer.profile_id != marked.profile_id || others.is_empty() {
        return clear(pool, marked).await;
    }
    let queued = queue_new_matches(
        pool,
        service,
        rate_limiter,
        viewer,
        others,
        None,
        None,
        false,
    );
    match queued.await? {
        (Queued::Pending(Pending::Running), true) => {
            clear(pool, marked).await.map(|_| Rematch::Queued)
        }
        (Queued::Pending(Pending::Running), false) => Ok(Rematch::Waiting),
        // A failed run, the budget or declined AI: matches refresh when
        // someone opens them.
        _ => clear(pool, marked).await,
    }
}

/// Forgets the mark unless the card was marked again after the claim.
async fn clear(pool: &PgPool, marked: &Marked) -> sqlx_core::Result<Rematch> {
    query(
        "UPDATE cloud_common_ground_cards SET rematch_at = NULL
         WHERE profile_id = $1 AND rematch_at = $2",
    )
    .bind(&marked.profile_id)
    .bind(marked.claimed)
    .execute(pool)
    .await?;
    Ok(Rematch::Cleared)
}

/// Up to [`MATCH_BATCH`] (account, profile) pairs `profile_id` has a stored
/// match with as the viewer that is not current for both cards, and that
/// `account` still sees through a pairing or an open room by the rules of
/// [`people::links`]: opened matches first, newest opening first, then the
/// newest computed. The query narrows to pairings and open rooms; the links
/// decide.
async fn partners(
    pool: &PgPool,
    account: &str,
    profile_id: &str,
) -> sqlx_core::Result<Vec<(String, String)>> {
    let sql = format!(
        "SELECT m.other_account_id, m.other_profile_id
         FROM cloud_common_ground_matches m
         JOIN cloud_common_ground_cards mine ON mine.profile_id = m.viewer_profile_id
         JOIN cloud_common_ground_cards theirs ON theirs.profile_id = m.other_profile_id
         WHERE m.viewer_profile_id = $1
           AND (mine.revision <> m.viewer_revision OR theirs.revision <> m.other_revision)
           AND (EXISTS (
                    SELECT 1 FROM cloud_common_ground_pairings pairing
                    WHERE (pairing.profile_a = $1 AND pairing.profile_b = m.other_profile_id)
                       OR (pairing.profile_b = $1 AND pairing.profile_a = m.other_profile_id))
                OR EXISTS (
                    SELECT 1 FROM cloud_common_ground_room_members my_member
                    JOIN cloud_common_ground_room_members their_member
                      ON their_member.room_id = my_member.room_id
                         AND their_member.profile_id = m.other_profile_id
                         AND their_member.left_at IS NULL
                    JOIN cloud_common_ground_rooms room ON room.room_id = my_member.room_id
                    WHERE my_member.profile_id = $1 AND my_member.left_at IS NULL
                      AND {ROOM_OPEN_SQL}))
         ORDER BY m.opened_at DESC NULLS LAST, m.computed_at DESC, m.other_profile_id
         LIMIT $2"
    );
    let rows: Vec<(String, String)> = query_as(&sql)
        .bind(profile_id)
        .bind(CANDIDATES)
        .fetch_all(pool)
        .await?;
    let mut links: HashMap<String, Vec<people::Link>> = HashMap::new();
    let mut found = Vec::new();
    for (other, other_profile) in rows {
        if !links.contains_key(&other) {
            let seen = people::links(pool, account, &other).await?;
            links.insert(other.clone(), seen);
        }
        let live = links[&other].iter().any(|link| {
            link.live && link.viewer_profile == profile_id && link.other_profile == other_profile
        });
        if live {
            found.push((other, other_profile));
            if found.len() == MATCH_BATCH {
                break;
            }
        }
    }
    Ok(found)
}
