import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import type { CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { patchCanonicalCloudMessages } from '../src/features/cloud/cloudReactionProjection';
import type { CanonicalSessionState } from '../src/kordi-app/types';

// Bea asks "@Facilitator hi". The server shows the Facilitator's reply row
// processing, then edits it in place into the reply, like a member agent's
// reply slot (#2547).
const groupId = 'session:group:facilitator-row';
const slotId = 'facilitator-reply:request';
const createdAt = '2026-11-13T10:00:00Z';

function rowWire(version: number, deliveryState: 'processing' | 'complete', text: string): CloudMessage {
  return {
    messageId: 'cloud-facilitator-row', fromAccountId: 'acct_kordi_pip', toAccountId: 'acct_bea', createdAt,
    deliveredAt: null, readAt: null, direction: 'incoming', conversationId: 'conversation', version,
    reactions: [], sessionId: groupId,
    body: encodeCloudGroupControl({
      kind: 'group-message', groupId, groupTitle: null, createdByAccountId: 'acct_bea',
      actor: { accountId: 'acct_bea', displayName: 'Synthetic Bea', avatarUrl: null, role: 'person' },
      participants: [{ accountId: 'acct_bea', displayName: 'Synthetic Bea', avatarUrl: null, role: 'person' }],
      message: {
        id: slotId, senderAccountId: 'acct_kordi_pip', senderKind: 'agent', senderAgentId: 'cloud_agent_kordi_pip',
        senderDisplayName: 'Facilitator', senderOwnerName: 'Facilitator', text, createdAtMs: Date.parse(createdAt),
        deliveryState, requestId: 'request', replyToMessageId: 'request',
      },
    }),
  };
}

const beaView: CanonicalSessionState = {
  profile: { id: 'profile:bea', humanIdentityId: 'human:bea' },
  identities: [
    { id: 'agent:facilitator', kind: 'agent', humanId: 'acct_kordi_pip', agentId: 'cloud_agent_kordi_pip', displayName: 'Facilitator' },
    { id: 'human:bea', kind: 'human', humanId: 'acct_bea', displayName: 'Synthetic Bea' },
  ],
  sessions: [{ id: groupId, kind: 'group' }],
  participants: [],
  messages: [{
    id: slotId, sessionId: groupId, senderIdentityId: 'agent:facilitator', senderRole: 'external-agent',
    messageKind: 'agent-turn', contentText: '', contentHash: null, parentMessageId: 'request',
    content: { deliveryState: 'processing', requestId: 'request', senderOwnerAccountId: 'acct_kordi_pip', cloudGroupMessageId: slotId, cloudMessageVersion: 1 },
    status: 'processing', createdAtMs: Date.parse(createdAt), updatedAtMs: Date.parse(createdAt), sequenceNum: 2,
    sourceTransport: 'cloud-group-agent', sourceEventId: 'cloud-group-agent:cloud-facilitator-row',
  }],
} as unknown as CanonicalSessionState;

function render(wire: CloudMessage) {
  const index = buildCloudMessageIndex('acct_bea', { acct_kordi_pip: [wire] });
  const projected = patchCanonicalCloudMessages(beaView, index.groupRows)!;
  const identities = new Map(projected.identities.map((identity) => [identity.id, identity]));
  return projected.messages.map((message) => mapCanonicalMessage(message, identities, 'human:bea'));
}

test('the Facilitator shows a working row that becomes its reply in place', () => {
  const working = render(rowWire(1, 'processing', ''));
  assert.equal(working.length, 1);
  assert.equal(working[0]?.turn?.completed, false, 'the row shows the Facilitator working');
  assert.equal(working[0]?.turn?.assistantText ?? '', '', 'never an empty reply bubble');
  assert.equal(working[0]?.sender, 'Facilitator');
  assert.equal(working[0]?.senderProfileImageUrl, '/kordi-system-avatar.jpg');

  const replied = render(rowWire(2, 'complete', 'Hi Bea! I can find a time or open a vote.'));
  assert.equal(replied.length, 1, 'one row, never gone and never two');
  assert.equal(replied[0]?.turn?.completed, true);
  assert.equal(replied[0]?.turn?.assistantText, 'Hi Bea! I can find a time or open a vote.');
  assert.equal(replied[0]?.sender, 'Facilitator');
});
