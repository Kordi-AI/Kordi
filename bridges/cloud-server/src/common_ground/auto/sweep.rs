//! The sweep: claims marked cards whose time has come, decides each one
//! ([`super::decide`]), reads what changed, and queues at most one
//! automatic update per card. Claims use `SKIP LOCKED` and push the card's
//! next look a minute out, so sweeps on several servers never take the same
//! card. Automatic updates never use the manual build rate limit. The same
//! tick then matches changed cards again (`matching::rematch`).

use chrono::{DateTime, Duration, Utc};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::config::AutoRebuildConfig;
use super::decide::{decide, CardState, Decision, Hold};
use super::{delta, prompt, AUTO_PREFIX};
use crate::auth::rate_limit::CloudRateLimiter;
use crate::common_ground::card::{
    self, CardRow, AUTO_IN_FLIGHT_SQL, BUILD_IN_FLIGHT_SQL, CAUGHT_UP_SQL,
};
use crate::common_ground::runs::{self, NewRun};
use crate::common_ground::{matching, profiles};

/// Cards one sweep looks at.
const BATCH: i64 = 20;
/// When the resource pool declines an update, the card waits this long.
const DECLINED_RETRY_MINUTES: i64 = 30;

/// What happened to one claimed card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::common_ground) enum Outcome {
    /// An automatic update was queued.
    Queued,
    /// Nothing new for the card, or the setting is off: the marks were
    /// cleared, and no run was queued.
    Cleared,
    /// Still within the quiet window.
    Waiting,
    Held(Hold),
    /// The resource pool did not admit the run.
    Declined,
}

type ClaimRow = (
    String,
    String,
    bool,
    bool,
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
    bool,
    bool,
    i64,
    i64,
    bool,
    Option<DateTime<Utc>>,
    DateTime<Utc>,
);

struct Claimed {
    profile_id: String,
    account_id: String,
    state: CardState,
    /// Changes after this time are new to the card.
    caught_up_at: Option<DateTime<Utc>>,
    /// The time the claim read the card; the update's input is as of then.
    snapshot: DateTime<Utc>,
}

async fn claim(pool: &PgPool) -> sqlx_core::Result<Vec<Claimed>> {
    let sql = format!(
        "UPDATE cloud_common_ground_cards card SET auto_retry_after = now() + interval '1 minute'
         FROM (SELECT c.profile_id FROM cloud_common_ground_cards c
               WHERE c.auto_dirty_since IS NOT NULL AND c.auto_retry_after <= now()
               ORDER BY c.auto_retry_after LIMIT $1 FOR UPDATE SKIP LOCKED) picked
         WHERE card.profile_id = picked.profile_id
         RETURNING card.profile_id, card.account_id, card.auto_rebuild, card.built_at IS NOT NULL,
             card.auto_dirty_since, card.auto_last_change_at,
             ({BUILD_IN_FLIGHT_SQL}), ({AUTO_IN_FLIGHT_SQL}),
             (SELECT count(*) FROM cloud_common_ground_auto_runs r
              WHERE r.profile_id = card.profile_id AND r.created_at > now() - interval '1 hour'),
             (SELECT count(*) FROM cloud_common_ground_auto_runs r
              WHERE r.profile_id = card.profile_id AND r.created_at > now() - interval '1 day'),
             EXISTS (SELECT 1 FROM cloud_accounts consent
                     WHERE consent.account_id = card.account_id
                       AND consent.ai_consent_status = 'allowed'),
             ({CAUGHT_UP_SQL}), now()"
    );
    let rows: Vec<ClaimRow> = query_as(&sql).bind(BATCH).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|row| Claimed {
            profile_id: row.0,
            account_id: row.1,
            state: CardState {
                auto_rebuild: row.2,
                built: row.3,
                dirty_since: row.4,
                last_change_at: row.5,
                manual_in_flight: row.6,
                auto_in_flight: row.7,
                updates_last_hour: row.8,
                updates_last_day: row.9,
                consent_allowed: row.10,
            },
            caught_up_at: row.11,
            snapshot: row.12,
        })
        .collect())
}

/// One sweep: automatic updates, then matching changed cards again, charged
/// to `rate_limiter` like any match run. A card's failure is logged and
/// does not hold up the others.
pub(in crate::common_ground) async fn sweep(
    pool: &PgPool,
    service: &crate::system_agent::SystemAgentConfig,
    rate_limiter: &CloudRateLimiter,
    config: &AutoRebuildConfig,
) -> sqlx_core::Result<Vec<(String, Outcome)>> {
    let mut outcomes = Vec::new();
    for claimed in claim(pool).await? {
        let outcome = match decide(&claimed.state, claimed.snapshot, config) {
            Decision::Clear => clear(pool, &claimed).await.map(|()| Outcome::Cleared),
            Decision::Wait(at) => retry_at(pool, &claimed.profile_id, at)
                .await
                .map(|()| Outcome::Waiting),
            Decision::Hold(hold) => retry_at(
                pool,
                &claimed.profile_id,
                claimed.snapshot + hold.retry_in(),
            )
            .await
            .map(|()| Outcome::Held(hold)),
            Decision::Due => start(pool, service, &claimed).await,
        };
        match outcome {
            Ok(outcome) => outcomes.push((claimed.profile_id, outcome)),
            Err(error) => {
                eprintln!("[common-ground] Automatic update check failed for one card: {error}")
            }
        }
    }
    if let Err(error) = matching::rematch(pool, service, rate_limiter).await {
        eprintln!("[common-ground] Matching changed cards again failed: {error}");
    }
    Ok(outcomes)
}

/// Forgets the marks, unless a change arrived after the claim read them.
async fn clear(pool: &PgPool, claimed: &Claimed) -> sqlx_core::Result<()> {
    query(
        "UPDATE cloud_common_ground_cards SET auto_dirty_since = NULL,
             auto_last_change_at = NULL, auto_retry_after = now()
         WHERE profile_id = $1 AND (auto_last_change_at IS NULL OR auto_last_change_at <= $2)",
    )
    .bind(&claimed.profile_id)
    .bind(claimed.snapshot)
    .execute(pool)
    .await?;
    Ok(())
}

/// Nothing new for a built card: the changes up to the claim were read, so
/// they stop counting as new (`auto_seen_at`, never moved back), and the
/// marks are forgotten unless a change arrived after the claim. No run is
/// queued and nothing counts against the caps.
async fn caught_up(pool: &PgPool, claimed: &Claimed) -> sqlx_core::Result<()> {
    query(
        "UPDATE cloud_common_ground_cards SET
             auto_seen_at = GREATEST(auto_seen_at, $2),
             auto_dirty_since = CASE WHEN auto_last_change_at > $2 THEN auto_dirty_since END,
             auto_last_change_at = CASE WHEN auto_last_change_at > $2
                 THEN auto_last_change_at END,
             auto_retry_after = CASE WHEN auto_last_change_at > $2
                 THEN auto_retry_after ELSE now() END
         WHERE profile_id = $1 AND built_at IS NOT NULL",
    )
    .bind(&claimed.profile_id)
    .bind(claimed.snapshot)
    .execute(pool)
    .await?;
    Ok(())
}

async fn retry_at(pool: &PgPool, profile_id: &str, at: DateTime<Utc>) -> sqlx_core::Result<()> {
    query("UPDATE cloud_common_ground_cards SET auto_retry_after = $2 WHERE profile_id = $1")
        .bind(profile_id)
        .bind(at)
        .execute(pool)
        .await?;
    Ok(())
}

/// Reads what changed and queues the update. The marks taken by the update
/// are cleared in the same transaction; a change that arrives later leaves
/// the card marked.
async fn start(
    pool: &PgPool,
    service: &crate::system_agent::SystemAgentConfig,
    claimed: &Claimed,
) -> sqlx_core::Result<Outcome> {
    let account = claimed.account_id.as_str();
    let profile = profiles::get(pool, account, &claimed.profile_id).await?;
    let card = card::load(pool, &claimed.profile_id)
        .await?
        .filter(CardRow::has_card);
    let (Some(profile), Some(card), Some(since)) = (profile, card, claimed.caught_up_at) else {
        return clear(pool, claimed).await.map(|()| Outcome::Cleared);
    };
    let new = delta::gather(pool, &profile, &card.evidence, since).await?;
    if new.is_empty() {
        return caught_up(pool, claimed).await.map(|()| Outcome::Cleared);
    }
    let today = claimed.snapshot.date_naive().to_string();
    let system_prompt = prompt::system_prompt(&profile);
    let user_prompt = prompt::user_prompt(&today, &profile, &card.topics, &card.evidence, &new);
    let run_id = runs::new_run_id(AUTO_PREFIX);
    let mut tx = pool.begin().await?;
    let sql = format!(
        "UPDATE cloud_common_ground_cards card SET auto_run_id = $2, auto_started_at = $3,
             auto_evidence_json = $4,
             auto_dirty_since = CASE WHEN card.auto_last_change_at > $3
                 THEN card.auto_dirty_since END,
             auto_last_change_at = CASE WHEN card.auto_last_change_at > $3
                 THEN card.auto_last_change_at END,
             auto_retry_after = now()
         WHERE card.profile_id = $1 AND card.auto_rebuild AND card.built_at IS NOT NULL
           AND NOT ({BUILD_IN_FLIGHT_SQL}) AND NOT ({AUTO_IN_FLIGHT_SQL})"
    );
    let reserved = query(&sql)
        .bind(&claimed.profile_id)
        .bind(&run_id)
        .bind(claimed.snapshot)
        .bind(serde_json::to_value(&new).unwrap_or_default())
        .execute(&mut *tx)
        .await?;
    if reserved.rows_affected() == 0 {
        tx.rollback().await?;
        return Ok(Outcome::Held(Hold::InFlight));
    }
    // Background work names no organization: the owner's personal pool.
    let new_run = NewRun {
        run_id: &run_id,
        requester: account,
        conversation_id: None,
        organization_id: None,
        prompt: user_prompt,
        system_prompt: &system_prompt,
    };
    if !runs::insert(&mut tx, service, new_run).await? {
        tx.rollback().await?;
        let at = claimed.snapshot + Duration::minutes(DECLINED_RETRY_MINUTES);
        retry_at(pool, &claimed.profile_id, at).await?;
        return Ok(Outcome::Declined);
    }
    query("DELETE FROM cloud_common_ground_auto_runs WHERE profile_id = $1 AND created_at < now() - interval '2 days'")
        .bind(&claimed.profile_id)
        .execute(&mut *tx)
        .await?;
    query("INSERT INTO cloud_common_ground_auto_runs (run_id, profile_id) VALUES ($1, $2)")
        .bind(&run_id)
        .bind(&claimed.profile_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Outcome::Queued)
}
