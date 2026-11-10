-- "Share busy/free with people in my chats" (docs/development/chat-calendar.md).
--
-- When on, another member of a shared conversation, or their agent, may ask
-- the owner's own agent when the owner is free. That agent then reads busy
-- windows only, never event details. On by default; the owner can turn it off.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_accounts
    ADD COLUMN IF NOT EXISTS share_calendar_availability BOOLEAN NOT NULL DEFAULT TRUE;
