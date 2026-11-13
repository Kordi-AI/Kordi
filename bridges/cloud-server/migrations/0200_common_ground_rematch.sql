-- Matching again after a Grounding card changes (docs/common-ground.md).
--
-- A manual build or an automatic update that changes a card sets
-- `rematch_at`. The automatic-update sweep then queues one match run for
-- people the card already had a match with and is still linked to. While
-- the sweep holds a card, `rematch_at` is the time it looks again; null
-- means the card is not marked.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_common_ground_cards
    ADD COLUMN IF NOT EXISTS rematch_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_cards_rematch_due
    ON cloud_common_ground_cards (rematch_at)
    WHERE rematch_at IS NOT NULL;
