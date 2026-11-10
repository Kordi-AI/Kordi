-- Whether the profile Location and Time zone follow the owner's devices
-- ('automatic') or keep the value the owner set ('manual'). Devices write only
-- fields that are still automatic, so a manual value is never overwritten.
--
-- Location stays off ('manual') until the owner turns it on. Time zone is
-- automatic for accounts that never set one; an existing time zone was chosen
-- by hand, so it stays manual. 0188 and 0189 are left to parallel changes.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_accounts ADD COLUMN IF NOT EXISTS location_mode TEXT;
ALTER TABLE cloud_accounts ADD COLUMN IF NOT EXISTS time_zone_mode TEXT;

UPDATE cloud_accounts SET location_mode = 'manual' WHERE location_mode IS NULL;
UPDATE cloud_accounts
    SET time_zone_mode = CASE WHEN time_zone IS NULL THEN 'automatic' ELSE 'manual' END
    WHERE time_zone_mode IS NULL;

ALTER TABLE cloud_accounts ALTER COLUMN location_mode SET DEFAULT 'manual';
ALTER TABLE cloud_accounts ALTER COLUMN time_zone_mode SET DEFAULT 'automatic';
ALTER TABLE cloud_accounts ALTER COLUMN location_mode SET NOT NULL;
ALTER TABLE cloud_accounts ALTER COLUMN time_zone_mode SET NOT NULL;

ALTER TABLE cloud_accounts DROP CONSTRAINT IF EXISTS cloud_accounts_location_mode_check;
ALTER TABLE cloud_accounts ADD CONSTRAINT cloud_accounts_location_mode_check
    CHECK (location_mode IN ('automatic', 'manual'));
ALTER TABLE cloud_accounts DROP CONSTRAINT IF EXISTS cloud_accounts_time_zone_mode_check;
ALTER TABLE cloud_accounts ADD CONSTRAINT cloud_accounts_time_zone_mode_check
    CHECK (time_zone_mode IN ('automatic', 'manual'));
