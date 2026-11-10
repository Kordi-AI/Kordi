//! Marking cards after a change. One UPDATE per write, on built cards with
//! "Rebuild automatically" on; the sweep later decides whether the change
//! matters to each card. A failure is logged and never reaches the write.

use sqlx_core::query::query;
use sqlx_postgres::PgPool;

/// Records a change: the first unhandled one stays, the latest moves.
const MARK_SET: &str = "auto_dirty_since = COALESCE(card.auto_dirty_since, now()),
     auto_last_change_at = now()";

/// After the owner saved, edited, archived or moved a memory outside groups.
pub(crate) async fn note_memory_change(pool: &PgPool, account_id: &str) {
    let sql = format!(
        "UPDATE cloud_common_ground_cards card SET {MARK_SET}
         WHERE card.account_id = $1 AND card.auto_rebuild AND card.built_at IS NOT NULL"
    );
    if let Err(error) = query(&sql).bind(account_id).execute(pool).await {
        eprintln!("[common-ground] Could not mark cards after a memory change: {error}");
    }
}

/// After a new connector event: the owner's cards whose saved sources pick
/// that provider, while the connector is granted to the owner's default
/// agent, which is what a build reads.
pub(crate) async fn note_connector_event(pool: &PgPool, connector_id: &str, provider: &str) {
    let sql = format!(
        "UPDATE cloud_common_ground_cards card SET {MARK_SET}
         FROM cloud_connectors c, cloud_common_ground_profiles profile
         WHERE c.connector_id = $1 AND card.account_id = c.account_id
           AND profile.profile_id = card.profile_id
           AND card.auto_rebuild AND card.built_at IS NOT NULL
           AND COALESCE(profile.sources_json->'connectors', '[]'::jsonb) ? $2
           AND EXISTS (SELECT 1 FROM cloud_connector_agent_grants g
                       WHERE g.connector_id = c.connector_id
                         AND g.agent_id = 'cloud-agent:' || c.account_id)"
    );
    let marked = query(&sql)
        .bind(connector_id)
        .bind(provider)
        .execute(pool)
        .await;
    if let Err(error) = marked {
        eprintln!("[common-ground] Could not mark cards after a connector event: {error}");
    }
}
