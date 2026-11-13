//! Queueing match and room-theme runs, and reading what they stored. Match
//! results are kept per pair of profiles.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx_core::{query::query, query_as::query_as, transaction::Transaction};
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::prompt::{self, MATCH_SYSTEM, ROOM_SYSTEM};
use super::{MatchResult, SharedCard};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::common_ground::runs::{self, NewRun, MATCH_PREFIX, ROOM_PREFIX};
use crate::common_ground::{rooms, MATCH_LIMIT};

/// People matched by one run; larger rooms fill in over several runs.
pub(super) const MATCH_BATCH: usize = 8;
/// Members whose topics a room-theme run reads, in join order.
pub(super) const MAX_THEME_MEMBERS: usize = 60;

/// A run blocks another of its kind while it is open, and for two minutes
/// after it failed, so a failing provider is not called on every refresh.
const BLOCKING_RUN_SQL: &str = "created_at > now() - interval '15 minutes'
    AND (finished_at IS NULL OR (error_code IS NOT NULL AND finished_at > now() - interval '2 minutes'))";

/// Stored results for `viewer`, keyed by the other profile, that are still
/// valid for both current cards.
pub(in crate::common_ground) async fn fresh_results(
    pool: &PgPool,
    viewer: &SharedCard,
    others: &[SharedCard],
) -> sqlx_core::Result<HashMap<String, MatchResult>> {
    load_results(pool, viewer, others, true).await
}

/// The last stored result for `viewer` with each of `others`, whatever card
/// revisions it was computed from. A closed room shows these as they were.
pub(in crate::common_ground) async fn stored_results(
    pool: &PgPool,
    viewer: &SharedCard,
    others: &[SharedCard],
) -> sqlx_core::Result<HashMap<String, MatchResult>> {
    load_results(pool, viewer, others, false).await
}

async fn load_results(
    pool: &PgPool,
    viewer: &SharedCard,
    others: &[SharedCard],
    current_only: bool,
) -> sqlx_core::Result<HashMap<String, MatchResult>> {
    let ids: Vec<&str> = others.iter().map(|o| o.profile_id.as_str()).collect();
    let rows: Vec<(String, i64, i64, Value)> = query_as(
        "SELECT other_profile_id, viewer_revision, other_revision, result_json
         FROM cloud_common_ground_matches
         WHERE viewer_profile_id = $1 AND other_profile_id = ANY($2)",
    )
    .bind(&viewer.profile_id)
    .bind(&ids)
    .fetch_all(pool)
    .await?;
    let revisions: HashMap<&str, i64> = others
        .iter()
        .map(|o| (o.profile_id.as_str(), o.revision))
        .collect();
    Ok(rows
        .into_iter()
        .filter(|(other, viewer_revision, other_revision, _)| {
            !current_only
                || (*viewer_revision == viewer.revision
                    && revisions.get(other.as_str()) == Some(other_revision))
        })
        .filter_map(|(other, _, _, value)| Some((other, serde_json::from_value(value).ok()?)))
        .collect())
}

/// How queued work for a viewer or room stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::common_ground) enum Pending {
    /// A run is working (or was just queued).
    Running,
    /// The last run failed moments ago; the next request retries.
    Failed,
}

/// What asking for a run did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::common_ground) enum Queued {
    /// A run is working or paused after a failure; nothing was charged.
    Pending(Pending),
    /// A new run would exceed the matching budget; nothing was queued.
    Limited(Duration),
    /// Nobody could be matched: the viewer or every other person declined
    /// AI (`crate::ai_consent`). Nothing was queued or charged.
    Skipped,
}

/// Charges the matching budget for one run about to be queued. Only called
/// once no open or paused run blocks a new one, so polling is free.
async fn charge(rate_limiter: &CloudRateLimiter, account: &str) -> Option<Duration> {
    match rate_limiter
        .observe_account_limit(MATCH_LIMIT, account)
        .await
    {
        RateLimitDecision::Allowed => None,
        RateLimitDecision::Limited { retry_after } => Some(retry_after),
    }
}

async fn blocking_run(
    pool: &PgPool,
    column: &str,
    key: &str,
) -> sqlx_core::Result<Option<Pending>> {
    let sql = format!(
        "SELECT error_code IS NOT NULL FROM cloud_common_ground_match_runs
         WHERE kind = $2 AND {column} = $1 AND {BLOCKING_RUN_SQL} ORDER BY created_at DESC LIMIT 1"
    );
    let row: Option<(bool,)> = if column == "room_id" {
        let room: Uuid = key.parse().map_err(|_| sqlx_core::Error::RowNotFound)?;
        query_as(&sql)
            .bind(room)
            .bind("room")
            .fetch_optional(pool)
            .await?
    } else {
        query_as(&sql)
            .bind(key)
            .bind("match")
            .fetch_optional(pool)
            .await?
    };
    Ok(row.map(|(failed,)| {
        if failed {
            Pending::Failed
        } else {
            Pending::Running
        }
    }))
}

/// Serializes queueing for one room, so two members who ask at once never
/// both queue the same pair or both announce the first run. Taken before
/// any per-viewer lock.
async fn lock_room(tx: &mut Transaction<'_, Postgres>, room_id: Uuid) -> sqlx_core::Result<()> {
    query("SELECT pg_advisory_xact_lock(hashtext('common-ground-room-match:' || $1))")
        .bind(room_id.to_string())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// `stale` without the people whose own open match run already read the
/// viewer's current card: that run stores the pair for the viewer too
/// (`finish::complete`). Open means unfinished and in the window
/// [`BLOCKING_RUN_SQL`] uses.
async fn not_covered(
    tx: &mut Transaction<'_, Postgres>,
    viewer: &SharedCard,
    stale: Vec<SharedCard>,
) -> sqlx_core::Result<Vec<SharedCard>> {
    let ids: Vec<&str> = stale.iter().map(|card| card.profile_id.as_str()).collect();
    let runs: Vec<(String, Option<i64>)> = query_as(
        "SELECT viewer_profile_id, (cards_json -> 0 ->> 'revision')::bigint
         FROM cloud_common_ground_match_runs
         WHERE kind = 'match' AND finished_at IS NULL
           AND created_at > now() - interval '15 minutes' AND viewer_profile_id = ANY($1)
           AND cards_json @> jsonb_build_array(
               jsonb_build_object('profileId', $2::text, 'revision', $3::bigint))",
    )
    .bind(&ids)
    .bind(&viewer.profile_id)
    .bind(viewer.revision)
    .fetch_all(&mut **tx)
    .await?;
    let covered: HashSet<(String, i64)> = runs
        .into_iter()
        .filter_map(|(profile, revision)| Some((profile, revision?)))
        .collect();
    Ok(stale
        .into_iter()
        .filter(|card| !covered.contains(&(card.profile_id.clone(), card.revision)))
        .collect())
}

/// Queues a run matching `viewer` with up to [`MATCH_BATCH`] of `stale`,
/// unless one is already working for this viewer profile. A person whose
/// own open run already matches them with the viewer is left out; when
/// that leaves nobody, the viewer waits for those runs. Only a queued run
/// is charged to the viewer's matching budget.
pub(in crate::common_ground) async fn queue_matches(
    pool: &PgPool,
    service: &crate::system_agent::SystemAgentConfig,
    rate_limiter: &CloudRateLimiter,
    viewer: &SharedCard,
    stale: &[SharedCard],
    room_id: Option<Uuid>,
    organization_id: Option<&str>,
) -> sqlx_core::Result<Queued> {
    let queued = queue_new_matches(
        pool,
        service,
        rate_limiter,
        viewer,
        stale,
        room_id,
        organization_id,
    );
    Ok(queued.await?.0)
}

/// [`queue_matches`], and whether this call queued the run: false when a
/// run already at work, or other people's open runs, stand for it.
pub(super) async fn queue_new_matches(
    pool: &PgPool,
    service: &crate::system_agent::SystemAgentConfig,
    rate_limiter: &CloudRateLimiter,
    viewer: &SharedCard,
    stale: &[SharedCard],
    room_id: Option<Uuid>,
    organization_id: Option<&str>,
) -> sqlx_core::Result<(Queued, bool)> {
    // The viewer asked, so only declining stops them; another person's
    // card reaches the model only when they allowed AI (`crate::ai_consent`).
    if crate::ai_consent::is_declined(pool, &viewer.account_id).await? {
        return Ok((Queued::Skipped, false));
    }
    let ids: Vec<String> = stale
        .iter()
        .chain(std::iter::once(viewer))
        .map(|card| card.account_id.clone())
        .collect();
    let excluded = crate::ai_consent::not_allowed_among(pool, &ids).await?;
    let stale: Vec<SharedCard> = stale
        .iter()
        .filter(|card| !excluded.contains(&card.account_id))
        .cloned()
        .collect();
    if stale.is_empty() {
        return Ok((Queued::Skipped, false));
    }
    let mut tx = pool.begin().await?;
    if let Some(room_id) = room_id {
        lock_room(&mut tx, room_id).await?;
    }
    query("SELECT pg_advisory_xact_lock(hashtext('common-ground-match:' || $1))")
        .bind(&viewer.profile_id)
        .execute(&mut *tx)
        .await?;
    if let Some(pending) = blocking_run(pool, "viewer_profile_id", &viewer.profile_id).await? {
        return Ok((Queued::Pending(pending), false));
    }
    // Another person's run stores the pair for the viewer only when the
    // viewer allowed AI, as they did (`finish::both_ways`).
    let stale = if excluded.contains(&viewer.account_id) {
        stale
    } else {
        not_covered(&mut tx, viewer, stale).await?
    };
    if stale.is_empty() {
        return Ok((Queued::Pending(Pending::Running), false));
    }
    if let Some(retry_after) = charge(rate_limiter, &viewer.account_id).await {
        return Ok((Queued::Limited(retry_after), false));
    }
    if let Some(room_id) = room_id {
        rooms::announce_matching(&mut tx, room_id).await?;
    }
    let batch = &stale[..stale.len().min(MATCH_BATCH)];
    let run_id = runs::new_run_id(MATCH_PREFIX);
    let cards: Vec<&SharedCard> = std::iter::once(viewer).chain(batch).collect();
    query(
        "INSERT INTO cloud_common_ground_match_runs
             (run_id, kind, viewer_account_id, viewer_profile_id, room_id, cards_json)
         VALUES ($1, 'match', $2, $3, $4, $5)",
    )
    .bind(&run_id)
    .bind(&viewer.account_id)
    .bind(&viewer.profile_id)
    .bind(room_id)
    .bind(json!(cards))
    .execute(&mut *tx)
    .await?;
    let new_run = NewRun {
        run_id: &run_id,
        requester: &viewer.account_id,
        conversation_id: None,
        organization_id,
        prompt: prompt::match_prompt(viewer, batch),
        system_prompt: MATCH_SYSTEM,
    };
    if !runs::insert(&mut tx, service, new_run).await? {
        // The resource pool's daily limit is used up until the next UTC day.
        let retry_after = crate::resource_pools::usage::until_next_day();
        return Ok((Queued::Limited(retry_after), false));
    }
    tx.commit().await?;
    Ok((Queued::Pending(Pending::Running), true))
}

/// Identifies a room's member set, shared profiles and card revisions.
pub(super) fn members_key(members: &[SharedCard]) -> String {
    let mut parts: Vec<String> = members
        .iter()
        .map(|m| format!("{}:{}:{}", m.account_id, m.profile_id, m.revision))
        .collect();
    parts.sort();
    hex::encode(Sha256::digest(parts.join(",").as_bytes()))
}

/// Themes as (label, account ids) when they match the current members.
pub(super) async fn stored_themes(
    pool: &PgPool,
    room_id: Uuid,
    key: &str,
) -> sqlx_core::Result<Option<Vec<(String, Vec<String>)>>> {
    let row: Option<(Value,)> = query_as(
        "SELECT themes_json FROM cloud_common_ground_room_themes WHERE room_id = $1 AND members_key = $2",
    )
    .bind(room_id)
    .bind(key)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(|(value,)| serde_json::from_value(value).ok()))
}

/// The room's last stored themes, whatever member set they were computed
/// for. A closed room shows these as they were.
pub(super) async fn latest_themes(
    pool: &PgPool,
    room_id: Uuid,
) -> sqlx_core::Result<Option<Vec<(String, Vec<String>)>>> {
    let row: Option<(Value,)> =
        query_as("SELECT themes_json FROM cloud_common_ground_room_themes WHERE room_id = $1")
            .bind(room_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.and_then(|(value,)| serde_json::from_value(value).ok()))
}

/// Queues a room-theme run unless one is already working for this room.
/// The run is charged to `requester`'s matching budget.
pub(super) async fn queue_themes(
    pool: &PgPool,
    service: &crate::system_agent::SystemAgentConfig,
    rate_limiter: &CloudRateLimiter,
    room_id: Uuid,
    requester: &str,
    members: &[SharedCard],
    organization_id: Option<&str>,
) -> sqlx_core::Result<Queued> {
    // Callers leave out the requester if they declined AI and anyone else
    // who has not allowed it; a card that slipped through is never sent.
    let others: Vec<String> = members
        .iter()
        .filter(|card| card.account_id != requester)
        .map(|card| card.account_id.clone())
        .collect();
    if crate::ai_consent::is_declined(pool, requester).await?
        || !crate::ai_consent::not_allowed_among(pool, &others)
            .await?
            .is_empty()
    {
        return Ok(Queued::Skipped);
    }
    let mut tx = pool.begin().await?;
    lock_room(&mut tx, room_id).await?;
    query("SELECT pg_advisory_xact_lock(hashtext('common-ground-room:' || $1))")
        .bind(room_id.to_string())
        .execute(&mut *tx)
        .await?;
    if let Some(pending) = blocking_run(pool, "room_id", &room_id.to_string()).await? {
        return Ok(Queued::Pending(pending));
    }
    if let Some(retry_after) = charge(rate_limiter, requester).await {
        return Ok(Queued::Limited(retry_after));
    }
    rooms::announce_matching(&mut tx, room_id).await?;
    let run_id = runs::new_run_id(ROOM_PREFIX);
    query(
        "INSERT INTO cloud_common_ground_match_runs (run_id, kind, room_id, cards_json)
         VALUES ($1, 'room', $2, $3)",
    )
    .bind(&run_id)
    .bind(room_id)
    .bind(json!(members))
    .execute(&mut *tx)
    .await?;
    let new_run = NewRun {
        run_id: &run_id,
        requester,
        conversation_id: None,
        organization_id,
        prompt: prompt::room_prompt(members),
        system_prompt: ROOM_SYSTEM,
    };
    if !runs::insert(&mut tx, service, new_run).await? {
        // The resource pool's daily limit is used up until the next UTC day.
        return Ok(Queued::Limited(
            crate::resource_pools::usage::until_next_day(),
        ));
    }
    tx.commit().await?;
    Ok(Queued::Pending(Pending::Running))
}
