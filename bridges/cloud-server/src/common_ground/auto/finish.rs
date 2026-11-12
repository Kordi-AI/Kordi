//! Finishing an automatic update. A reply that changes the card lands in
//! place with the same hint a build sends. A reply that changes nothing, an
//! unreadable reply and a failed run leave the card as it was, with no error
//! and no hint; the card waits for its next change. A run the card let go
//! (a manual build won, the setting was turned off, or the card was
//! deleted) is completed and its reply discarded.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::delta::NewItem;
use super::merge::{self, StoredCard};
use crate::common_ground::runs;

type Claimed = (
    Option<String>,
    Option<String>,
    Option<Value>,
    Option<DateTime<Utc>>,
);

pub(in crate::common_ground) async fn complete(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    text: &str,
) -> sqlx_core::Result<()> {
    let row: Option<Claimed> = query_as(
        "SELECT card.account_id, card.profile_id, card.auto_evidence_json, card.auto_started_at
         FROM cloud_agent_fallback_runs run
         LEFT JOIN cloud_common_ground_cards card ON card.auto_run_id = run.run_id
         WHERE run.run_id = $1 AND run.claimed_by = $2 AND run.status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    let Some((account, profile_id, new, started_at)) = row else {
        return Err(sqlx_core::Error::RowNotFound);
    };
    let (Some(account), Some(profile_id), Some(_)) = (account, profile_id, started_at) else {
        return discard(pool, run_id, runner_id).await;
    };
    let new: Vec<NewItem> = new
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    let Some(update) = merge::parse_update(text) else {
        eprintln!("[common-ground] Discarded unreadable automatic update {run_id}");
        return fail(pool, run_id, Some(runner_id), "invalid_output").await;
    };
    let mut tx = pool.begin().await?;
    if !runs::mark_completed(&mut tx, run_id, runner_id).await? {
        return Err(sqlx_core::Error::RowNotFound);
    }
    let stored: Option<(Value, Value, Value)> = query_as(
        "SELECT topics_json, evidence_json, hidden_json FROM cloud_common_ground_cards
         WHERE profile_id = $1 AND auto_run_id = $2 FOR UPDATE",
    )
    .bind(&profile_id)
    .bind(run_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((topics, evidence, hidden)) = stored else {
        // Let go after the first read; nothing to store.
        return tx.commit().await;
    };
    let card = StoredCard {
        topics: serde_json::from_value(topics).unwrap_or_default(),
        evidence: serde_json::from_value(evidence).unwrap_or_default(),
        hidden: serde_json::from_value(hidden).unwrap_or_default(),
    };
    // Changes up to the time the input was read are taken either way.
    let Some(merged) = merge::merge(&card, &update, &new) else {
        query(
            "UPDATE cloud_common_ground_cards SET auto_seen_at = auto_started_at,
                 auto_run_id = NULL, auto_evidence_json = NULL
             WHERE profile_id = $1 AND auto_run_id = $2",
        )
        .bind(&profile_id)
        .bind(run_id)
        .execute(&mut *tx)
        .await?;
        return tx.commit().await;
    };
    query(
        "UPDATE cloud_common_ground_cards SET topics_json = $3, evidence_json = $4,
             hidden_json = $5, revision = revision + 1,
             built_at = GREATEST(built_at, auto_started_at), auto_seen_at = auto_started_at,
             auto_run_id = NULL, auto_evidence_json = NULL, updated_at = now()
         WHERE profile_id = $1 AND auto_run_id = $2",
    )
    .bind(&profile_id)
    .bind(run_id)
    .bind(serde_json::to_value(&merged.topics).unwrap_or_default())
    .bind(serde_json::to_value(&merged.evidence).unwrap_or_default())
    .bind(json!(merged.hidden))
    .execute(&mut *tx)
    .await?;
    crate::common_ground::hint(
        &mut tx,
        &account,
        "common_ground.card.updated",
        json!({ "built": true, "profileId": profile_id, "automatic": true }),
    )
    .await?;
    tx.commit().await?;
    crate::common_ground::rooms::announce_profile(pool, &profile_id).await;
    Ok(())
}

/// Completes a run the card no longer waits for, keeping its reply out.
async fn discard(pool: &PgPool, run_id: &str, runner_id: &str) -> sqlx_core::Result<()> {
    let mut tx = pool.begin().await?;
    if !runs::mark_completed(&mut tx, run_id, runner_id).await? {
        return Err(sqlx_core::Error::RowNotFound);
    }
    tx.commit().await
}

/// A failed automatic update frees the card and says nothing: no error code,
/// no hint, and no retry until a new change arrives.
pub(in crate::common_ground) async fn fail(
    pool: &PgPool,
    run_id: &str,
    runner_id: Option<&str>,
    code: &str,
) -> sqlx_core::Result<()> {
    let mut tx = pool.begin().await?;
    if !runs::mark_failed(&mut tx, run_id, runner_id, code, "Card update failed.").await? {
        return Ok(());
    }
    query(
        "UPDATE cloud_common_ground_cards SET auto_run_id = NULL, auto_evidence_json = NULL
         WHERE auto_run_id = $1",
    )
    .bind(run_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}
