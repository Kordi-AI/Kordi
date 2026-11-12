-- Shorten outstanding questions while preserving earlier deadlines.
SET LOCAL lock_timeout = '5s';

UPDATE cloud_agent_exchanges
SET deadline_at = created_at + interval '2 hours'
WHERE status = 'pending'
  AND deadline_at > created_at + interval '2 hours';
