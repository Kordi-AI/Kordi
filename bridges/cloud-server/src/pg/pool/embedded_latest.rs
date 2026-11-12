//! Embedded Postgres migrations from version 193 on, in version order.

use super::{migration_entry::migration, EmbeddedMigration};

/// Migrations from version 193 on.
pub(super) const LATEST_MIGRATIONS: &[EmbeddedMigration] = &[
    migration!(
        193,
        "agent person exchanges",
        "0193_agent_person_exchanges.sql"
    ),
    migration!(
        194,
        "calendar share availability",
        "0194_calendar_share_availability.sql"
    ),
    migration!(195, "agent plan cards", "0195_agent_plan_cards.sql"),
    migration!(
        197,
        "session lookup cache signals",
        "0197_session_lookup_cache_signals.sql"
    ),
];
