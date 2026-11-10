-- "Rebuild automatically" for Grounding cards (docs/common-ground.md).
--
-- The setting is per card and off by default. Memory writes and new
-- connector events mark a card that has it on; a sweep worker queues one
-- incremental update once changes go quiet or have waited long enough.
-- Automatic updates never touch `active_run_id` or `build_error_code`, so a
-- manual build and its error state are unchanged.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_common_ground_cards
    ADD COLUMN IF NOT EXISTS auto_rebuild BOOLEAN NOT NULL DEFAULT FALSE,
    -- The first change no automatic update has taken yet, and the latest.
    ADD COLUMN IF NOT EXISTS auto_dirty_since TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS auto_last_change_at TIMESTAMPTZ,
    -- When the sweep looks at a marked card again.
    ADD COLUMN IF NOT EXISTS auto_retry_after TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The automatic update in flight, when its input was read, and the
    -- redacted new evidence it was given, so its reply can be resolved.
    ADD COLUMN IF NOT EXISTS auto_run_id TEXT,
    ADD COLUMN IF NOT EXISTS auto_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS auto_evidence_json JSONB,
    -- Changes up to this time reached an automatic update that finished,
    -- even one that changed nothing.
    ADD COLUMN IF NOT EXISTS auto_seen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_cards_auto_due
    ON cloud_common_ground_cards (auto_retry_after)
    WHERE auto_dirty_since IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_common_ground_cards_auto_run
    ON cloud_common_ground_cards (auto_run_id)
    WHERE auto_run_id IS NOT NULL;

-- Automatic updates queued per card, for the hourly and daily caps. Manual
-- builds are not recorded here and never count against them.
CREATE TABLE IF NOT EXISTS cloud_common_ground_auto_runs (
    run_id     TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES cloud_common_ground_profiles(profile_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_auto_runs_profile
    ON cloud_common_ground_auto_runs (profile_id, created_at);
