//! `PUT /v1/cloud/common-ground/settings` body handling: sharing and
//! "Rebuild automatically" are each optional, and a field left out keeps
//! its value.

use serde::Deserialize;
use sqlx_core::query::query;
use sqlx_postgres::PgPool;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::common_ground) struct SettingsRequest {
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub sharing: Option<bool>,
    #[serde(default)]
    pub auto_rebuild: Option<bool>,
}

impl SettingsRequest {
    /// Whether the body names a setting to change.
    pub fn names_a_setting(&self) -> bool {
        self.sharing.is_some() || self.auto_rebuild.is_some()
    }
}

/// Writes the named settings, creating the card row when needed. Sharing
/// moves the card's revision, as it always did; the automatic setting does
/// not, since others see nothing new. Turning the setting on marks a built
/// card so changes already made since its build land after the quiet
/// window; the sweep clears the mark when nothing relevant changed.
/// Turning it off forgets the marks and lets an update in flight go, so
/// its reply is discarded.
pub(in crate::common_ground) async fn apply(
    pool: &PgPool,
    profile_id: &str,
    account_id: &str,
    request: &SettingsRequest,
) -> sqlx_core::Result<()> {
    query(
        "INSERT INTO cloud_common_ground_cards AS card
             (profile_id, account_id, sharing_enabled, auto_rebuild)
         VALUES ($1, $2, COALESCE($3::boolean, TRUE), COALESCE($4::boolean, FALSE))
         ON CONFLICT (profile_id) DO UPDATE SET
             sharing_enabled = COALESCE($3::boolean, card.sharing_enabled),
             auto_rebuild = COALESCE($4::boolean, card.auto_rebuild),
             auto_dirty_since = CASE
                 WHEN $4::boolean IS FALSE THEN NULL
                 WHEN $4::boolean AND NOT card.auto_rebuild AND card.built_at IS NOT NULL
                     THEN COALESCE(card.auto_dirty_since, now())
                 ELSE card.auto_dirty_since END,
             auto_last_change_at = CASE
                 WHEN $4::boolean IS FALSE THEN NULL
                 WHEN $4::boolean AND NOT card.auto_rebuild AND card.built_at IS NOT NULL
                     THEN now()
                 ELSE card.auto_last_change_at END,
             auto_retry_after = CASE
                 WHEN $4::boolean AND NOT card.auto_rebuild THEN now()
                 ELSE card.auto_retry_after END,
             auto_run_id = CASE WHEN $4::boolean IS FALSE THEN NULL ELSE card.auto_run_id END,
             auto_evidence_json = CASE
                 WHEN $4::boolean IS FALSE THEN NULL ELSE card.auto_evidence_json END,
             revision = card.revision + CASE WHEN $3::boolean IS NULL THEN 0 ELSE 1 END,
             updated_at = now()",
    )
    .bind(profile_id)
    .bind(account_id)
    .bind(request.sharing)
    .bind(request.auto_rebuild)
    .execute(pool)
    .await?;
    Ok(())
}
