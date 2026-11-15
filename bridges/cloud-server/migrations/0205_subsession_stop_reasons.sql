-- Why a background session's execution was stopped: who pressed Stop, or
-- what else ended it (the Mac's lease lapsed after refused updates, sign-out,
-- the app quit, the group closed). NULL while running and for executions that
-- finished or failed. A new execution clears it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_agent_subsessions ADD COLUMN IF NOT EXISTS stop_reason JSONB;
