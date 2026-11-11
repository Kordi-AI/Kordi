-- A memory may carry one to three HCP categories. `categories` keeps them in
-- the order given; the first is the primary category and is mirrored into
-- the existing `category` column, which stays for older code and queries.
-- Every existing memory keeps its one category.

ALTER TABLE cloud_account_memories ADD COLUMN IF NOT EXISTS categories TEXT[];

UPDATE cloud_account_memories SET categories = ARRAY[category] WHERE categories IS NULL;

ALTER TABLE cloud_account_memories ALTER COLUMN categories SET NOT NULL;

-- One to three known categories, no repeats, no nulls, numbered from one,
-- and the first equal to `category`.
ALTER TABLE cloud_account_memories DROP CONSTRAINT IF EXISTS cloud_account_memories_categories_check;
ALTER TABLE cloud_account_memories ADD CONSTRAINT cloud_account_memories_categories_check
    CHECK (
        cardinality(categories) BETWEEN 1 AND 3
        AND array_ndims(categories) = 1
        AND array_lower(categories, 1) = 1
        AND array_position(categories, NULL) IS NULL
        AND categories <@ ARRAY['general_preferences', 'goals_and_constraints',
            'health_context', 'education_learner_profile', 'work_context',
            'purchase_history_preferences', 'values_and_ethics',
            'location_context', 'coordination_context', 'hcp-custom:task_lessons']::TEXT[]
        AND category = categories[1]
        AND (cardinality(categories) < 2 OR categories[1] <> categories[2])
        AND (cardinality(categories) < 3
            OR (categories[1] <> categories[3] AND categories[2] <> categories[3]))
    );

-- Older server builds (during a rolling update or after a rollback) write
-- only `category`. Keep `categories` in step for them: an insert without
-- categories gets the one category, and an update that changes only the
-- category replaces the first element and keeps the others.
CREATE OR REPLACE FUNCTION cloud_account_memories_sync_categories()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.categories IS NULL THEN
            NEW.categories := ARRAY[NEW.category];
        END IF;
    ELSIF NEW.category IS DISTINCT FROM OLD.category
        AND NEW.categories IS NOT DISTINCT FROM OLD.categories THEN
        NEW.categories := ARRAY[NEW.category]
            || array_remove(COALESCE(OLD.categories[2:3], ARRAY[]::TEXT[]), NEW.category);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cloud_account_memories_sync_categories ON cloud_account_memories;
CREATE TRIGGER cloud_account_memories_sync_categories
    BEFORE INSERT OR UPDATE OF category, categories ON cloud_account_memories
    FOR EACH ROW EXECUTE FUNCTION cloud_account_memories_sync_categories();
