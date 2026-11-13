//! Storing what a finished match or room-theme run found, and failing runs.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::store::members_key;
use super::{prompt, reads_for_either, result, reversed, MatchResult, SharedCard};
use crate::common_ground::runs;

type RunRow = (String, Option<String>, Option<Uuid>, Value);

/// Stores what a finished match or room run found. A reply that is not the
/// expected JSON fails the run instead.
pub(in crate::common_ground) async fn complete(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    text: &str,
) -> sqlx_core::Result<()> {
    let row: Option<RunRow> = query_as(
        "SELECT kind, viewer_account_id, room_id, cards_json FROM cloud_common_ground_match_runs
         WHERE run_id = $1 AND finished_at IS NULL",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?;
    let Some((kind, viewer, room_id, cards)) = row else {
        return Err(sqlx_core::Error::RowNotFound);
    };
    let cards: Vec<SharedCard> = serde_json::from_value(cards).unwrap_or_default();
    let current = current_revisions(pool, &cards).await?;
    let is_current = |card: &SharedCard| current.get(&card.profile_id) == Some(&card.revision);
    let mut tx = pool.begin().await?;
    if !runs::mark_completed(&mut tx, run_id, runner_id).await? {
        return Err(sqlx_core::Error::RowNotFound);
    }
    if kind == "match" {
        let (Some(viewer_card), others) = (cards.first(), cards.get(1..).unwrap_or_default())
        else {
            return Err(sqlx_core::Error::RowNotFound);
        };
        let Some(found) = prompt::parse_matches(text, viewer_card, others) else {
            drop(tx);
            eprintln!("[common-ground] Rejected run {run_id}: the reply is not a match list");
            return fail(pool, run_id, Some(runner_id), "invalid_output").await;
        };
        // Cards that changed while the run worked are matched again later.
        if is_current(viewer_card) {
            let both_ways = both_ways(pool, viewer_card, others).await?;
            for (other, found) in others.iter().zip(found) {
                if !is_current(other) {
                    continue;
                }
                let names = [viewer_card.name.as_str(), other.name.as_str()];
                if both_ways.contains(&other.account_id) && reads_for_either(&found, &names) {
                    let mirrored = result(other, viewer_card, reversed(&found));
                    store(&mut tx, other, viewer_card, &mirrored, true).await?;
                }
                store(
                    &mut tx,
                    viewer_card,
                    other,
                    &result(viewer_card, other, found),
                    false,
                )
                .await?;
            }
        }
        if let Some(viewer) = &viewer {
            let payload = json!({ "profileId": viewer_card.profile_id });
            crate::common_ground::hint(&mut tx, viewer, "common_ground.matches.updated", payload)
                .await?;
            crate::common_ground::nearby::run_finished(&mut tx, viewer).await?;
        }
        tell_others(&mut tx, others).await?;
    } else if let Some(room_id) = room_id {
        let Some(themes) = prompt::parse_themes(text, cards.len()) else {
            drop(tx);
            eprintln!("[common-ground] Rejected run {run_id}: the reply is not a theme list");
            return fail(pool, run_id, Some(runner_id), "invalid_output").await;
        };
        let themes: Vec<(String, Vec<String>)> = themes
            .into_iter()
            .map(|(label, people)| {
                (
                    label,
                    people
                        .into_iter()
                        .map(|i| cards[i].account_id.clone())
                        .collect(),
                )
            })
            .collect();
        if cards.iter().all(is_current) {
            query(
                "INSERT INTO cloud_common_ground_room_themes (room_id, members_key, themes_json)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (room_id) DO UPDATE SET members_key = EXCLUDED.members_key,
                     themes_json = EXCLUDED.themes_json, computed_at = now()",
            )
            .bind(room_id)
            .bind(members_key(&cards))
            .bind(json!(themes))
            .execute(&mut *tx)
            .await?;
        }
        notify_room(&mut tx, room_id).await?;
    }
    if !finish(&mut tx, run_id, None).await? {
        return Err(sqlx_core::Error::RowNotFound);
    }
    tx.commit().await
}

pub(in crate::common_ground) async fn fail(
    pool: &PgPool,
    run_id: &str,
    runner_id: Option<&str>,
    code: &str,
) -> sqlx_core::Result<()> {
    let mut tx = pool.begin().await?;
    // A runner that lost its lease, or a repeated report, changes nothing.
    if !runs::mark_failed(&mut tx, run_id, runner_id, code, "Matching failed.").await? {
        return Ok(());
    }
    let row: Option<(Option<String>, Option<Uuid>, Value)> = query_as(
        "SELECT viewer_account_id, room_id, cards_json FROM cloud_common_ground_match_runs
         WHERE run_id = $1 AND finished_at IS NULL",
    )
    .bind(run_id)
    .fetch_optional(&mut *tx)
    .await?;
    if !finish(&mut tx, run_id, Some(code)).await? {
        return Ok(());
    }
    match row {
        Some((Some(viewer), _, cards)) => {
            crate::common_ground::hint(
                &mut tx,
                &viewer,
                "common_ground.matches.updated",
                json!({}),
            )
            .await?;
            crate::common_ground::nearby::run_finished(&mut tx, &viewer).await?;
            let cards: Vec<SharedCard> = serde_json::from_value(cards).unwrap_or_default();
            tell_others(&mut tx, cards.get(1..).unwrap_or_default()).await?;
        }
        Some((None, Some(room_id), _)) => notify_room(&mut tx, room_id).await?,
        _ => {}
    }
    tx.commit().await
}

/// The other people of a match run who get its finding too: none unless the
/// viewer allowed AI use of their card for other people's requests, and
/// only those who still allow it themselves (`crate::ai_consent`).
async fn both_ways(
    pool: &PgPool,
    viewer: &SharedCard,
    others: &[SharedCard],
) -> sqlx_core::Result<HashSet<String>> {
    let ids: Vec<String> = std::iter::once(viewer)
        .chain(others)
        .map(|card| card.account_id.clone())
        .collect();
    let excluded = crate::ai_consent::not_allowed_among(pool, &ids).await?;
    if excluded.contains(&viewer.account_id) {
        return Ok(HashSet::new());
    }
    Ok(ids
        .into_iter()
        .skip(1)
        .filter(|id| !excluded.contains(id))
        .collect())
}

/// Stores `result` for `viewer` with `other` at the revisions of both cards.
/// A `mirrored` result, read from the other side's run, never replaces one
/// already computed for the same two revisions, so a score never changes
/// under someone who has it. `opened_at` is left alone either way.
async fn store(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    viewer: &SharedCard,
    other: &SharedCard,
    result: &MatchResult,
    mirrored: bool,
) -> sqlx_core::Result<()> {
    query(
        "INSERT INTO cloud_common_ground_matches AS stored
             (viewer_account_id, other_account_id, viewer_profile_id, other_profile_id,
              viewer_revision, other_revision, result_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (viewer_profile_id, other_profile_id) DO UPDATE SET
             viewer_revision = EXCLUDED.viewer_revision, other_revision = EXCLUDED.other_revision,
             result_json = EXCLUDED.result_json, computed_at = now()
         WHERE NOT $8::boolean OR stored.viewer_revision <> EXCLUDED.viewer_revision
             OR stored.other_revision <> EXCLUDED.other_revision",
    )
    .bind(&viewer.account_id)
    .bind(&other.account_id)
    .bind(&viewer.profile_id)
    .bind(&other.profile_id)
    .bind(viewer.revision)
    .bind(other.revision)
    .bind(json!(result))
    .bind(mirrored)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Tells everyone else a finished match run read to refresh: it may have
/// stored their side of the pair, and a person whose request waited on it
/// (`store::queue_matches`) queues their own run when it did not.
async fn tell_others(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    others: &[SharedCard],
) -> sqlx_core::Result<()> {
    for other in others {
        let payload = json!({ "profileId": other.profile_id });
        crate::common_ground::hint(
            tx,
            &other.account_id,
            "common_ground.matches.updated",
            payload,
        )
        .await?;
        crate::common_ground::nearby::run_finished(tx, &other.account_id).await?;
    }
    Ok(())
}

/// Marks an open run finished and drops the cards it read: other people's
/// topics are not kept with a finished run. Returns false when the run was
/// already finished.
async fn finish(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    run_id: &str,
    error_code: Option<&str>,
) -> sqlx_core::Result<bool> {
    let changed = query(
        "UPDATE cloud_common_ground_match_runs SET finished_at = now(), error_code = $2, cards_json = '[]'::jsonb
         WHERE run_id = $1 AND finished_at IS NULL",
    )
    .bind(run_id)
    .bind(error_code)
    .execute(&mut **tx)
    .await?;
    Ok(changed.rows_affected() > 0)
}

async fn notify_room(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    room_id: Uuid,
) -> sqlx_core::Result<()> {
    let members: Vec<(String, String)> = query_as(
        "SELECT member.account_id, room.code FROM cloud_common_ground_room_members member
         JOIN cloud_common_ground_rooms room ON room.room_id = member.room_id
         WHERE member.room_id = $1 AND member.left_at IS NULL",
    )
    .bind(room_id)
    .fetch_all(&mut **tx)
    .await?;
    for (account, code) in members {
        crate::common_ground::hint(
            tx,
            &account,
            "common_ground.room.updated",
            json!({ "code": code }),
        )
        .await?;
    }
    Ok(())
}

/// Current revisions of the cards that are still shared, by profile.
async fn current_revisions(
    pool: &PgPool,
    cards: &[SharedCard],
) -> sqlx_core::Result<HashMap<String, i64>> {
    let ids: Vec<&str> = cards.iter().map(|c| c.profile_id.as_str()).collect();
    let rows: Vec<(String, i64)> = query_as(
        "SELECT profile_id, revision FROM cloud_common_ground_cards
         WHERE profile_id = ANY($1) AND built_at IS NOT NULL AND sharing_enabled",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().collect())
}
