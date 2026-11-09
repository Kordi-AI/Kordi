-- An agent may ask a person in the same conversation and wait for the answer.
-- A person target runs nothing: there is no target agent and no target run.
-- The answer is that person's next human message in the conversation after the
-- question, or their reply to the question. People get a longer deadline.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_agent_exchanges
    ADD COLUMN IF NOT EXISTS target_kind TEXT NOT NULL DEFAULT 'agent',
    ADD COLUMN IF NOT EXISTS target_person_id TEXT
        REFERENCES cloud_accounts (account_id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS conversation_id UUID
        REFERENCES cloud_chat_conversations (conversation_id) ON DELETE CASCADE,
    ALTER COLUMN target_owner_id DROP NOT NULL,
    ALTER COLUMN target_agent_id DROP NOT NULL;

ALTER TABLE cloud_agent_exchanges
    DROP CONSTRAINT IF EXISTS cloud_agent_exchanges_target_kind_check,
    ADD CONSTRAINT cloud_agent_exchanges_target_kind_check CHECK (
        (target_kind = 'agent'
            AND target_owner_id IS NOT NULL
            AND target_agent_id IS NOT NULL
            AND target_person_id IS NULL)
        OR (target_kind = 'person'
            AND target_person_id IS NOT NULL
            AND conversation_id IS NOT NULL
            AND target_owner_id IS NULL
            AND target_agent_id IS NULL
            AND target_run_id IS NULL)
    );

CREATE INDEX IF NOT EXISTS cloud_agent_exchanges_person_pending
    ON cloud_agent_exchanges (conversation_id, target_person_id, created_at)
    WHERE target_kind = 'person' AND status = 'pending';

CREATE INDEX IF NOT EXISTS cloud_agent_exchanges_person_answers
    ON cloud_agent_exchanges (target_person_id, response_message_id)
    WHERE target_kind = 'person';
