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
        196,
        "memory categories multi",
        "0196_memory_categories_multi.sql"
    ),
    migration!(
        197,
        "session lookup cache signals",
        "0197_session_lookup_cache_signals.sql"
    ),
    migration!(
        198,
        "agent exchange wait limit",
        "0198_agent_exchange_wait_limit.sql"
    ),
    migration!(199, "facilitator cards", "0199_facilitator_cards.sql"),
    migration!(
        200,
        "common ground rematch",
        "0200_common_ground_rematch.sql"
    ),
    migration!(
        201,
        "cloud run lease attempts",
        "0201_cloud_run_lease_attempts.sql"
    ),
    migration!(
        204,
        "subsession stop reasons",
        "0204_subsession_stop_reasons.sql"
    ),
];
