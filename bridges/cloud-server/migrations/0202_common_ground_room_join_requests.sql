-- Ask to join: a person in a Grounding room asks to join a group started
-- from it (docs/common-ground.md). The group's approvers see the request as
-- a card that System posts in the group chat, refreshed in place by
-- `revision`, and approve or decline it there or in the room.
--
-- `status` moves once from 'pending' to 'approved', 'declined' or
-- 'cancelled' (the requester withdrew it). A person has at most one pending
-- request per group. `message_id` is the card message, once posted.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_common_ground_room_join_requests (
    request_id           UUID PRIMARY KEY,
    room_id              UUID NOT NULL REFERENCES cloud_common_ground_rooms(room_id) ON DELETE CASCADE,
    group_space_id       TEXT NOT NULL REFERENCES cloud_common_ground_room_groups(group_space_id) ON DELETE CASCADE,
    requester_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    status               TEXT NOT NULL
        CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
    revision             BIGINT NOT NULL DEFAULT 1,
    message_id           UUID NULL,
    decided_by           TEXT NULL REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at           TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_common_ground_room_join_requests_pending
    ON cloud_common_ground_room_join_requests (group_space_id, requester_account_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_room_join_requests_room
    ON cloud_common_ground_room_join_requests (room_id, group_space_id);

-- An invitee can decline a room invitation (from the room or Contacts ›
-- Requests); a declined invitation is no longer listed anywhere.
ALTER TABLE cloud_common_ground_room_invitations
    ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ NULL;
