-- Credentials of deleted accounts (docs/development/account-deletion.md).
-- Deleting an account lists here the hashes of its session tokens (app
-- bearer tokens and web session cookies) and browser sign-in refresh tokens
-- that still worked, so a client presenting one is told `account_deleted`
-- instead of a plain sign-out. A row holds only the hash, its kind and when
-- the credential would have expired anyway, at most 30 days after the
-- deletion: no account, device, email or name. A background sweep deletes
-- expired rows.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_deleted_account_credentials (
    credential_hash TEXT PRIMARY KEY CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
    kind            TEXT NOT NULL CHECK (kind IN ('session', 'refresh')),
    expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_deleted_account_credentials_expiry
    ON cloud_deleted_account_credentials (expires_at);
