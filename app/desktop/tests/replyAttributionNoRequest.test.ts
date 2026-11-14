import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { buildReplyAttribution } from '../src/features/chat/replyAttribution';
import type { CanonicalIdentity, CanonicalSessionMessage, Message } from '../src/kordi-app/types';
import { humanRequest, turn } from './helpers/replyAttributionFixtures';

// A document a background task saved is posted by the server as the agent's own
// message, naming no request. Another member's unanswered mention of the same
// agent must not be quoted on it.
const agentIdentity = {
  id: 'agent:cloud:acct_owner',
  kind: 'agent',
  displayName: "Owner's Kordi",
  ownerIdentityId: 'human:acct_owner',
} as CanonicalIdentity;

function storedAgentMessage(content: Record<string, unknown>): CanonicalSessionMessage {
  return {
    id: 'msg:cloud-agent-document:att_agentdoc_1',
    sessionId: 'session:group:g1',
    senderIdentityId: agentIdentity.id,
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: 'For Owner’s request: “Do a literature review”',
    content: {
      sender: "Owner's Kordi",
      deliveryState: 'complete',
      cloudGroupMessageId: 'msg:cloud-agent-document:att_agentdoc_1',
      attachments: [{ attachmentId: 'att_agentdoc_1', name: 'review.md', kind: 'file', mimeType: 'text/markdown', sizeBytes: 32 }],
      ...content,
    },
    parentMessageId: null,
    status: 'received',
    sequenceNum: 3,
    createdAtMs: 3,
    updatedAtMs: 3,
    sourceTransport: 'cloud-group-agent',
    sourceEventId: 'cloud-group-agent:msg:cloud-agent-document:att_agentdoc_1',
  } as unknown as CanonicalSessionMessage;
}

const unrelatedMention = humanRequest({
  id: 'msg:bea-hi',
  role: 'person',
  sender: 'Bea',
  isOwnMessage: false,
  text: "@OwnersKordi hi",
  mentions: [{ label: 'OwnersKordi', targetKind: 'agent' } as NonNullable<Message['mentions']>[number]],
});

function mapped(content: Record<string, unknown> = {}) {
  const message = mapCanonicalMessage(storedAgentMessage(content), new Map([[agentIdentity.id, agentIdentity]]), 'human:acct_owner');
  assert.ok(message?.turn);
  return message;
}

test('a stored agent message that names no request is never quoted as a reply', () => {
  const document = mapped();
  assert.equal(document.answersNoRequest, true);
  const result = buildReplyAttribution([unrelatedMention, document], null, { inferLatestHumanRequest: true });
  const shown = result.messages[1];
  assert.ok(!shown.replyToMessageId);
  assert.ok(!shown.sourceMessage);
  assert.ok(!shown.turn?.sourceMessage);
  assert.ok(!result.messages[0].replySummary);
});

test('a stored agent reply with its request keeps that quote', () => {
  const request = humanRequest({ id: 'msg:owner-request', text: 'Do a literature review' });
  const reply = mapped({ requestId: 'msg:owner-request', replyToMessageId: 'msg:owner-request' });
  assert.equal(reply.answersNoRequest, undefined);
  const result = buildReplyAttribution([request, unrelatedMention, reply], null, { inferLatestHumanRequest: true });
  assert.equal(result.messages[2].replyToMessageId, 'msg:owner-request');
});

test('a local agent turn without ids still links to the mention that asked it', () => {
  const local: Message = {
    id: 'local-turn',
    role: 'owned-agent',
    sender: "Owner's Kordi",
    senderType: 'agent',
    text: '',
    time: '10:01',
    turn: turn({ id: 'turn-local', assistantText: 'Hi Bea.' }),
  };
  const result = buildReplyAttribution([unrelatedMention, local], null, { inferLatestHumanRequest: true });
  assert.equal(result.messages[1].replyToMessageId, 'msg:bea-hi');
});
