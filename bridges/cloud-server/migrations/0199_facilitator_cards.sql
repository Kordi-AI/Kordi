CREATE TABLE cloud_facilitator_cards (
    card_id UUID PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    conversation_id UUID NOT NULL REFERENCES cloud_chat_conversations(conversation_id) ON DELETE CASCADE,
    sender_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('decision', 'memory', 'task')),
    content JSONB NOT NULL,
    votes JSONB NOT NULL DEFAULT '{}',
    revision BIGINT NOT NULL DEFAULT 1,
    result TEXT,
    message_id UUID REFERENCES cloud_chat_messages(message_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cloud_facilitator_cards_conversation
    ON cloud_facilitator_cards (conversation_id, kind, created_at DESC);

ALTER TABLE cloud_agent_proactive_proposals
    ADD COLUMN facilitator_task BOOLEAN NOT NULL DEFAULT FALSE;

DROP INDEX idx_cloud_agent_proactive_proposals_one_pending;

CREATE UNIQUE INDEX idx_cloud_agent_proactive_proposals_one_pending
    ON cloud_agent_proactive_proposals (agent_id, conversation_id)
    WHERE status = 'pending' AND NOT facilitator_task;
