-- Invite Grounding people into groups (docs/common-ground.md): a group
-- owner or admin invites someone they share a room or an opened match with.
-- Contacts are added directly; everyone else gets an invitation here and
-- joins or declines it from Contacts › Requests.
--
-- `status` moves once from 'pending' to 'accepted', 'declined' or
-- 'withdrawn' (the inviter could no longer invite when the invitee tried to
-- join). A person has at most one pending invitation per group.
-- `source_room_id` is a room both were in when invited; NULL means a match.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_common_ground_group_invitations (
    invitation_id      UUID PRIMARY KEY,
    conversation_id    UUID NOT NULL REFERENCES cloud_chat_conversations(conversation_id) ON DELETE CASCADE,
    group_space_id     TEXT NOT NULL,
    inviter_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    invitee_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    source_room_id     UUID NULL REFERENCES cloud_common_ground_rooms(room_id) ON DELETE SET NULL,
    status             TEXT NOT NULL
        CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at         TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_common_ground_group_invitations_pending
    ON cloud_common_ground_group_invitations (conversation_id, invitee_account_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_group_invitations_invitee
    ON cloud_common_ground_group_invitations (invitee_account_id, status);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_group_invitations_inviter
    ON cloud_common_ground_group_invitations (inviter_account_id, status);
