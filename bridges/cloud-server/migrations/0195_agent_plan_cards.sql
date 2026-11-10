-- Plan cards opened by a person's agent (issue #2446).
--
-- A card a person's agent opens records which agent planned it, the name it
-- had then (calendar entries say "Planned with <name> in <chat>."), and the
-- task (the root run of the request) that opened it, so one task opens at
-- most one card. Cards the System agent or a member opens leave these empty.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_plan_cards
    ADD COLUMN IF NOT EXISTS created_by_agent_id TEXT,
    ADD COLUMN IF NOT EXISTS created_by_agent_name TEXT,
    ADD COLUMN IF NOT EXISTS created_by_task_run_id TEXT;

CREATE INDEX IF NOT EXISTS idx_cloud_plan_cards_agent_task
    ON cloud_plan_cards(created_by_task_run_id)
    WHERE created_by_task_run_id IS NOT NULL;
