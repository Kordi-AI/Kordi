-- Bounded retries for Cloud runner leases.
--
-- Every Cloud runner lease of a run adds one to `cloud_lease_attempts`. A
-- run whose lease lapsed that many times without the runner finishing it is
-- not leased again; the run sweep fails it through the normal failure path
-- with `run_attempts_exhausted`, so its feature shows a failed state instead
-- of staying in progress.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN IF NOT EXISTS cloud_lease_attempts INTEGER NOT NULL DEFAULT 0;
