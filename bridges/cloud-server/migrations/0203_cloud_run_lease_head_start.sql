-- Lease order for runs a person is waiting on (docs/common-ground.md).
--
-- The Cloud runner leases queued runs oldest first. A run with a head start
-- counts as queued that many seconds earlier, so it is leased before runs
-- queued less than that before it, and never before a run that has waited
-- longer. Grounding gives one to a match run queued because someone opened a
-- person, so it does not wait behind a large room's bulk runs. Every other
-- run keeps 0 and its place in the queue.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN IF NOT EXISTS lease_head_start_seconds INTEGER NOT NULL DEFAULT 0;
