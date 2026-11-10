-- Telegram-style read receipts (issue #2455).
--
-- cloud_chat_read_outbox: per author and conversation, the highest sequence of
-- the author's own messages that another member has read. Read advances raise
-- it, and only the authors whose value rose are told, so a read in a large
-- group no longer reaches every author it passes. It lives apart from the
-- member row so that two members reading each other's messages never lock each
-- other's member rows.
--
-- cloud_chat_read_marks: one row each time a member's read cursor moves, over
-- (after_sequence, through_sequence]. The time a member read message M is the
-- read_at of the mark whose range holds M; the retention sweep prunes marks
-- after seven days, and a reader without that mark has no read time.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS cloud_chat_read_outbox (
    conversation_id UUID NOT NULL
                    REFERENCES cloud_chat_conversations(conversation_id) ON DELETE CASCADE,
    account_id      TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    sequence        BIGINT NOT NULL CHECK (sequence >= 0),
    PRIMARY KEY (conversation_id, account_id)
);

CREATE TABLE IF NOT EXISTS cloud_chat_read_marks (
    conversation_id  UUID NOT NULL
                     REFERENCES cloud_chat_conversations(conversation_id) ON DELETE CASCADE,
    account_id       TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    after_sequence   BIGINT NOT NULL CHECK (after_sequence >= 0),
    through_sequence BIGINT NOT NULL,
    read_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, account_id, through_sequence),
    CHECK (through_sequence > after_sequence)
);

CREATE INDEX IF NOT EXISTS idx_cloud_chat_read_marks_retention
    ON cloud_chat_read_marks(read_at);

-- Each member's watermark from the cursors already stored: their highest
-- message at or below the furthest read cursor of any other member.
INSERT INTO cloud_chat_read_outbox (conversation_id, account_id, sequence)
SELECT author.conversation_id, author.account_id, MAX(message.conversation_sequence)
FROM cloud_chat_conversation_members author
JOIN LATERAL (
    SELECT MAX(other.last_read_sequence) AS read_through
    FROM cloud_chat_conversation_members other
    WHERE other.conversation_id = author.conversation_id
      AND other.account_id <> author.account_id
) readers ON TRUE
JOIN cloud_chat_messages message
  ON message.conversation_id = author.conversation_id
 AND message.sender_account_id = author.account_id
 AND message.conversation_sequence <= readers.read_through
GROUP BY author.conversation_id, author.account_id
ON CONFLICT (conversation_id, account_id) DO NOTHING;
