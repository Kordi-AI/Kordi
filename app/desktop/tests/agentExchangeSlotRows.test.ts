import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCloudCollaborationConversation } from '../src/features/cloud/cloudCollaborationState';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { cloudAccountAvatarFixture as avatar } from './helpers/cloudAccountAvatarFixture';

// The server's slot rows for runs started by an exchange (a resume after an
// answer, or an agent answering another agent): one row per run, edited in place.
const owner = { accountId: 'owner', displayName: 'Owner', primaryEmail: 'owner@example.test', avatarUrl: null, avatar, nodeId: 'owner', passwordSet: true,
  defaultAgent: { agentId: 'cloud-agent:owner', displayName: 'Owner Agent', avatarUrl: null, avatar } } as unknown as CloudAccount;
const peer = { ...owner, accountId: 'peer', displayName: 'Peer', nodeId: 'peer', defaultAgent: null } as CloudAccount;
const at = new Date().toISOString();
const slot = (fields: Record<string, unknown>, createdAt = at) => ({
  messageId: 'slot', fromAccountId: owner.accountId, toAccountId: peer.accountId, createdAt,
  body: `kordi-cloud-agent-response:${Buffer.from(JSON.stringify({ kind: 'agent-response', requestId: 'agent-exchange:synthetic:continued', text: '', ...fields })).toString('base64url')}`,
}) as CloudMessage;
const answer = { messageId: 'answer', fromAccountId: peer.accountId, toAccountId: owner.accountId, createdAt: at, body: '7pm works' } as CloudMessage;

function rows(row: CloudMessage, viewer: CloudAccount) {
  const conversation = buildCloudCollaborationConversation({ account: viewer,
    contact: cloudContactToContact({ ...(viewer === owner ? peer : owner), createdAt: at } as never),
    messages: [answer, row], runtime: 'person', localAgentTurnsByRequestId: {} });
  return mapCollaborationConversationToViewModel(conversation as never, undefined, 'Kordi').messages
    .filter((message) => !message.id.endsWith(':answer'));
}

test('an exchange run shows its processing row to everyone, then its answer in the same row', () => {
  for (const viewer of [owner, peer]) {
    const [processing] = rows(slot({ deliveryState: 'processing' }), viewer);
    assert.equal(processing.turn?.status, 'processing');
    assert.equal(processing.turn?.completed, false);
    const done = rows(slot({ deliveryState: 'complete', text: 'Booked Friday at 7pm.' }), viewer);
    assert.equal(done.length, 1);
    assert.equal(done[0].id, processing.id, 'the answer replaces the processing row in place');
    assert.equal(done[0].turn?.assistantText, 'Booked Friday at 7pm.');
    assert.notEqual(done[0].turn?.status, 'processing');
    // The server ends every slot row, so a long run keeps its row without a heartbeat.
    const longRun = rows(slot({ deliveryState: 'processing' }, new Date(Date.now() - 5 * 60_000).toISOString()), viewer);
    assert.equal(longRun[0]?.turn?.status, 'processing');
  }
});

test('a silent or waiting run retires its row, and a stop or failure never keeps spinning', () => {
  for (const viewer of [owner, peer]) {
    const retired = rows(slot({ deliveryState: 'complete', synchronizationOnly: true }), viewer);
    assert.deepEqual(retired, [], 'no spinner, no empty bubble');
    for (const ending of [{ deliveryState: 'cancelled', text: 'Stopped' }, { deliveryState: 'failed', text: 'The agent could not complete this request.' }]) {
      for (const message of rows(slot(ending), viewer)) {
        assert.notEqual(message.turn?.status, 'processing', JSON.stringify(ending));
      }
    }
  }
});
