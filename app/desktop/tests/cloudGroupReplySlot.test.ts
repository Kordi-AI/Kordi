import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import type { CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { patchCanonicalCloudMessages } from '../src/features/cloud/cloudReactionProjection';
import type { CanonicalSessionState } from '../src/kordi-app/types';

// A member (Synthetic Member) asks the owner's agent; the owner's Mac answers
// (#2416). The server edits the agent's processing row in place, so the row
// keeps its message id and only its version, text and state change.
const groupId = 'session:group:reply-slot';
const slotId = 'msg:cloud-agent-processing:request:acct_owner';
const createdAt = '2026-11-13T10:00:00Z';

function slotWire(version: number, deliveryState: 'processing' | 'complete', text: string): CloudMessage {
  return {
    messageId: 'cloud-slot-row', fromAccountId: 'acct_owner', toAccountId: 'acct_member', createdAt,
    deliveredAt: null, readAt: null, direction: 'incoming', conversationId: 'conversation', version,
    reactions: [], sessionId: groupId,
    body: encodeCloudGroupControl({
      kind: 'group-message', groupId, groupTitle: null, createdByAccountId: 'acct_member',
      actor: { accountId: 'acct_owner', displayName: 'Synthetic Owner', avatarUrl: null, role: 'person' },
      participants: [
        { accountId: 'acct_owner', displayName: 'Synthetic Owner', avatarUrl: null, role: 'person' },
        { accountId: 'acct_member', displayName: 'Synthetic Member', avatarUrl: null, role: 'person' },
      ],
      message: {
        id: slotId, senderAccountId: 'acct_owner', senderKind: 'agent', senderAgentId: 'cloud-agent:acct_owner',
        senderDisplayName: 'Kordi', text, createdAtMs: Date.parse(createdAt), deliveryState,
        requestId: 'request', replyToMessageId: 'request',
      },
    }),
  };
}

// The member's canonical row, as the processing row first arrived.
const memberView: CanonicalSessionState = {
  profile: { id: 'profile:member', humanIdentityId: 'human:member' },
  identities: [
    { id: 'agent:owner', kind: 'agent', ownerIdentityId: 'human:owner', displayName: 'Kordi' },
    { id: 'human:member', kind: 'human', humanId: 'acct_member', displayName: 'Synthetic Member' },
  ],
  sessions: [{ id: groupId, kind: 'group' }],
  participants: [],
  messages: [{
    id: slotId, sessionId: groupId, senderIdentityId: 'agent:owner', senderRole: 'external-agent',
    messageKind: 'agent-turn', contentText: '', contentHash: null, parentMessageId: 'request',
    content: { deliveryState: 'processing', requestId: 'request', cloudGroupMessageId: slotId, cloudMessageVersion: 1 },
    status: 'processing', createdAtMs: Date.parse(createdAt), updatedAtMs: Date.parse(createdAt), sequenceNum: 2,
    sourceTransport: 'cloud-group-agent', sourceEventId: 'cloud-group-agent:cloud-slot-row',
  }],
} as unknown as CanonicalSessionState;

function visibleTurns(wire: CloudMessage) {
  const index = buildCloudMessageIndex('acct_member', { acct_owner: [wire] });
  const projected = patchCanonicalCloudMessages(memberView, index.groupRows)!;
  const identities = new Map(projected.identities.map((identity) => [identity.id, identity]));
  return projected.messages.map((message) => mapCanonicalMessage(message, identities, 'human:member')?.turn);
}

test('a member sees the processing row become the reply in one update, never an empty frame', () => {
  const processing = visibleTurns(slotWire(1, 'processing', ''));
  assert.equal(processing.length, 1);
  assert.equal(processing[0]?.completed, false, 'the row shows the agent working');

  // The same update that carries the edited row renders the reply in that row.
  const replied = visibleTurns(slotWire(2, 'complete', 'Synthetic answer.'));
  assert.equal(replied.length, 1, 'one row, no gap and no second row');
  assert.equal(replied[0]?.completed, true);
  assert.equal(replied[0]?.assistantText, 'Synthetic answer.');
});
