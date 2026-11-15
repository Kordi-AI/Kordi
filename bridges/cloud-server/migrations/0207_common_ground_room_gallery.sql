-- Room gallery: people in a Grounding room share their own artifacts
-- (documents and files from their Kordi chats) with the room
-- (docs/common-ground.md). Members read and comment; nobody edits.
--
-- An item is one attachment its owner shared in one room. `title`,
-- `file_name` and `preview` (the first characters of a text file, else
-- NULL) are copied when it is shared. Rows are deleted, never archived:
-- removing an item, leaving the room, or deleting the attachment, the room
-- or the account deletes the item and its comments.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_common_ground_room_gallery_items (
    item_id       UUID PRIMARY KEY,
    room_id       UUID NOT NULL REFERENCES cloud_common_ground_rooms(room_id) ON DELETE CASCADE,
    account_id    TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL REFERENCES cloud_attachments(attachment_id) ON DELETE CASCADE,
    title         TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    file_name     TEXT NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
    topic         TEXT NULL CHECK (char_length(topic) BETWEEN 1 AND 80),
    preview       TEXT NULL CHECK (char_length(preview) <= 800),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (room_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_room_gallery_items_room
    ON cloud_common_ground_room_gallery_items (room_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_room_gallery_items_account
    ON cloud_common_ground_room_gallery_items (account_id, room_id);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_room_gallery_items_attachment
    ON cloud_common_ground_room_gallery_items (attachment_id);

-- Comments are visible to everyone in the room who sees their author.
CREATE TABLE IF NOT EXISTS cloud_common_ground_room_gallery_comments (
    comment_id UUID PRIMARY KEY,
    item_id    UUID NOT NULL
        REFERENCES cloud_common_ground_room_gallery_items(item_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_room_gallery_comments_item
    ON cloud_common_ground_room_gallery_comments (item_id, created_at);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_room_gallery_comments_account
    ON cloud_common_ground_room_gallery_comments (account_id);
