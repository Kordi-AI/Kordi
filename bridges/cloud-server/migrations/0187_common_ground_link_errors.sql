-- Links a Grounding card build could not read (docs/common-ground.md).
--
-- Each entry is {"url": ..., "reason": ...}. A build that starts replaces
-- the list, so the card and the Build screen can say which links were not
-- read instead of ignoring them.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_common_ground_cards
    ADD COLUMN IF NOT EXISTS link_errors_json JSONB NOT NULL DEFAULT '[]'::jsonb;
