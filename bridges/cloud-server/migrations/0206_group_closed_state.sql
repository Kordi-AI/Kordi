-- Closing a group (docs/development/group-closed-state.md).
--
-- A group owner or admin closes a group or one of its channels. The
-- conversation keeps its members and history so everyone can still read it,
-- but nothing new is written: no messages, reactions, agent runs, calls,
-- plan cards, members or channels. `closed_at` is null for an open
-- conversation; `closed_by_account_id` is who closed it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_chat_conversations
    ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS closed_by_account_id TEXT
        REFERENCES cloud_accounts(account_id) ON DELETE SET NULL;
