-- Keep per-replica session lookup caches exact.
--
-- Each server replica caches successful session lookups for a few seconds.
-- Migration 0175 already signals revocation, deletion, and admission
-- changes on `cloud_session_signals`. A cached lookup also carries the
-- session's organization claim, the account's personal organization, and
-- whether the account is still a member of the claimed organization, so
-- these triggers publish a `refresh` signal when any of those facts can
-- change. Open sockets ignore `refresh`; only cached lookups are dropped.
-- Older replicas do not parse the new kind and ignore it.
--
-- Payload: {"a": account_id, "d": device_id | null, "t": token_id | null,
--           "k": "refresh"}
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION cloud_organization_members_signal_refresh() RETURNS trigger AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        PERFORM cloud_notify_session_signal(OLD.account_id, NULL, NULL, 'refresh');
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        PERFORM cloud_notify_session_signal(NEW.account_id, NULL, NULL, 'refresh');
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cloud_organization_members_signal_refresh ON cloud_organization_members;
CREATE TRIGGER cloud_organization_members_signal_refresh
    AFTER INSERT OR DELETE ON cloud_organization_members
    FOR EACH ROW EXECUTE FUNCTION cloud_organization_members_signal_refresh();

DROP TRIGGER IF EXISTS cloud_organization_members_signal_refresh_update ON cloud_organization_members;
CREATE TRIGGER cloud_organization_members_signal_refresh_update
    AFTER UPDATE OF organization_id, account_id, expires_at ON cloud_organization_members
    FOR EACH ROW
    WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id
          OR OLD.account_id IS DISTINCT FROM NEW.account_id
          OR OLD.expires_at IS DISTINCT FROM NEW.expires_at)
    EXECUTE FUNCTION cloud_organization_members_signal_refresh();

CREATE OR REPLACE FUNCTION cloud_organizations_signal_refresh() RETURNS trigger AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.personal_account_id IS NOT NULL THEN
        PERFORM cloud_notify_session_signal(OLD.personal_account_id, NULL, NULL, 'refresh');
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.personal_account_id IS NOT NULL THEN
        PERFORM cloud_notify_session_signal(NEW.personal_account_id, NULL, NULL, 'refresh');
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cloud_organizations_signal_refresh ON cloud_organizations;
CREATE TRIGGER cloud_organizations_signal_refresh
    AFTER INSERT OR DELETE ON cloud_organizations
    FOR EACH ROW EXECUTE FUNCTION cloud_organizations_signal_refresh();

DROP TRIGGER IF EXISTS cloud_organizations_signal_refresh_update ON cloud_organizations;
CREATE TRIGGER cloud_organizations_signal_refresh_update
    AFTER UPDATE OF personal_account_id ON cloud_organizations
    FOR EACH ROW
    WHEN (OLD.personal_account_id IS DISTINCT FROM NEW.personal_account_id)
    EXECUTE FUNCTION cloud_organizations_signal_refresh();

-- A session's organization claim changes when the app switches
-- organization (or an organization is deleted and the claim is emptied).
-- Sliding the expiry forward on use is not signalled: a cached lookup keeps
-- the earlier expiry, which is only ever stricter. Moving it earlier is.
CREATE OR REPLACE FUNCTION cloud_refresh_tokens_signal_refresh() RETURNS trigger AS $$
BEGIN
    PERFORM cloud_notify_session_signal(OLD.account_id, NULL, OLD.token_id, 'refresh');
    IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
        PERFORM cloud_notify_session_signal(NEW.account_id, NULL, NEW.token_id, 'refresh');
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cloud_refresh_tokens_signal_refresh ON cloud_refresh_tokens;
CREATE TRIGGER cloud_refresh_tokens_signal_refresh
    AFTER UPDATE OF organization_id, expires_at, account_id, device_id, token_hash,
        app_sign_in_id ON cloud_refresh_tokens
    FOR EACH ROW
    WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id
          OR NEW.expires_at::timestamptz < OLD.expires_at::timestamptz
          OR OLD.account_id IS DISTINCT FROM NEW.account_id
          OR OLD.device_id IS DISTINCT FROM NEW.device_id
          OR OLD.token_hash IS DISTINCT FROM NEW.token_hash
          OR OLD.app_sign_in_id IS DISTINCT FROM NEW.app_sign_in_id)
    EXECUTE FUNCTION cloud_refresh_tokens_signal_refresh();

-- A device that moves to another account no longer authorizes the
-- sessions cached for the first one.
CREATE OR REPLACE FUNCTION cloud_devices_signal_refresh() RETURNS trigger AS $$
BEGIN
    PERFORM cloud_notify_session_signal(OLD.account_id, OLD.device_id, NULL, 'refresh');
    PERFORM cloud_notify_session_signal(NEW.account_id, NEW.device_id, NULL, 'refresh');
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cloud_devices_signal_refresh ON cloud_devices;
CREATE TRIGGER cloud_devices_signal_refresh
    AFTER UPDATE OF account_id ON cloud_devices
    FOR EACH ROW
    WHEN (OLD.account_id IS DISTINCT FROM NEW.account_id)
    EXECUTE FUNCTION cloud_devices_signal_refresh();
