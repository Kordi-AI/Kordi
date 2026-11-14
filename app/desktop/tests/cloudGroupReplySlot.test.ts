import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeCanonicalMessageRow } from '../src/features/canonical/canonicalStateReducers';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { removeCloudGroupPendingRowsForTerminalResponse } from '../src/features/cloud/cloudAgentRequestState';
import { cloudGroupAgentMentionResponseStateFromSources } from '../src/features/cloud/cloudGroupAgentResponseState';
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
    content: { deliveryState: 'processing', requestId: 'request', senderOwnerAccountId: 'acct_owner', cloudGroupMessageId: slotId, cloudMessageVersion: 1 },
    status: 'processing', createdAtMs: Date.parse(createdAt), updatedAtMs: Date.parse(createdAt), sequenceNum: 2,
    sourceTransport: 'cloud-group-agent', sourceEventId: 'cloud-group-agent:cloud-slot-row',
  }],
} as unknown as CanonicalSessionState;

function render(state: CanonicalSessionState, wire: CloudMessage) {
  const index = buildCloudMessageIndex('acct_member', { acct_owner: [wire] });
  const projected = patchCanonicalCloudMessages(state, index.groupRows)!;
  const identities = new Map(projected.identities.map((identity) => [identity.id, identity]));
  return { index, turns: projected.messages.map((message) => mapCanonicalMessage(message, identities, 'human:member')?.turn) };
}

function assertReply(turns: ReturnType<typeof render>['turns'], step: string) {
  assert.equal(turns.length, 1, `${step}: one row, never gone and never two`);
  assert.equal(turns[0]?.completed, true, step);
  assert.equal(turns[0]?.assistantText, 'Synthetic answer.', step);
}

test('a member sees the processing row become the reply in one update, never an empty frame', () => {
  const processing = render(memberView, slotWire(1, 'processing', ''));
  assert.equal(processing.turns.length, 1);
  assert.equal(processing.turns[0]?.completed, false, 'the row shows the agent working');

  // The edit to complete reaches the cloud index; the same render shows the reply in that row.
  const edited = slotWire(2, 'complete', 'Synthetic answer.');
  const { index, turns } = render(memberView, edited);
  assertReply(turns, 'edit received');

  // The member's request watcher sees a terminal reply and clears pending rows.
  // It must not take the row away before the stored reply replaces it.
  assert.equal(cloudGroupAgentMentionResponseStateFromSources({
    requestMessageId: 'request', targetAccountId: 'acct_owner', messages: memberView.messages, rows: index.groupRows,
  }), 'terminal');
  const cleared = removeCloudGroupPendingRowsForTerminalResponse(memberView, 'request', 'acct_owner')!;
  assertReply(render(cleared, edited).turns, 'pending rows cleared');

  // The stored reply lands in the same row, also when it arrives late or after a resync.
  const stored = mergeCanonicalMessageRow(cleared, {
    ...memberView.messages[0], status: 'received', contentText: 'Synthetic answer.',
    content: { ...memberView.messages[0].content as Record<string, unknown>, deliveryState: 'complete', cloudMessageVersion: 2 },
    sourceEventId: 'cloud-group-agent:cloud-slot-row:2',
  })!;
  assertReply(render(stored, edited).turns, 'stored reply');
  assertReply(render(removeCloudGroupPendingRowsForTerminalResponse(stored, 'request', 'acct_owner')!, edited).turns, 'after a resync');
});

test('a stale processing row still leaves once its reply is stored under another row', () => {
  const other = { ...memberView.messages[0], id: 'msg:other-reply', status: 'received', contentText: 'Synthetic answer.',
    content: { ...memberView.messages[0].content as Record<string, unknown>, deliveryState: 'complete' } };
  const state = { ...memberView, messages: [memberView.messages[0], other] } as CanonicalSessionState;
  const cleared = removeCloudGroupPendingRowsForTerminalResponse(state, 'request', 'acct_owner')!;
  assert.deepEqual(cleared.messages.map((message) => message.id), ['msg:other-reply']);
});
