import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { conversation, host } from './helpers/collaborationTranscriptFixtures';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import { normalizePlanCardSnapshot } from '../src/features/cloud/planCardSnapshot';
import { KORDI_SYSTEM_AVATAR_URL } from '../src/features/systemAgent/systemAgentIdentity';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { CanonicalIdentity, CanonicalSessionMessage } from '../src/kordi-app/types';

// A card a person's agent opened (issue #2446) travels in its owner's System notice but is
// that agent's message; the System agent's cards keep showing as System.
const plannedBy = { agentId: 'cloud-agent:acct_owner', agentName: 'Kordi', ownerAccountId: 'acct_owner', ownerName: 'Jamie Lin', avatarUrl: null };
const block = {
  type: 'plan_card', eventId: 'plan_coffee', title: 'Coffee chat', state: 'awaiting_confirmation', revision: 1, view: 'event',
  participants: [
    { participantId: 'acct_owner', displayName: 'Jamie Lin', organizer: true, rsvp: 'yes' },
    { participantId: 'acct_peer', displayName: 'Sam', organizer: false, rsvp: 'pending' },
  ],
};
const agentCard = normalizePlanCardSnapshot({ ...block, plannedBy });
const systemCard = normalizePlanCardSnapshot(block);

function directRow(direction: 'outbound' | 'inbound', card: typeof agentCard) {
  const view = mapCollaborationConversationToViewModel(conversation({
    messages: [{
      id: `card:${direction}`, direction, sender: direction === 'outbound' ? 'Me' : 'Jamie Lin', text: '', timeLabel: '09:04',
      timestampMs: 4, deliveryState: 'read', messageKind: 'system-notice', planCard: card,
    }],
  }), host(), 'My Kordi');
  const message = view.messages[0];
  if (!message) throw new Error('expected a mapped message');
  return message;
}

test('a plan card snapshot carries the agent that planned it, and only a valid one', () => {
  assert.deepEqual(agentCard?.plannedBy, plannedBy);
  assert.equal(systemCard?.plannedBy, null);
  assert.equal(normalizePlanCardSnapshot({ ...block, plannedBy: 'System' })?.plannedBy, null);
  assert.equal(normalizePlanCardSnapshot({ ...block, plannedBy: { agentName: 'Kordi' } })?.plannedBy, null);
});

test("the owner sees their agent's card as their agent's message, not System", () => {
  const message = directRow('outbound', agentCard);
  assert.equal(message.role, 'owned-agent');
  assert.equal(message.senderType, 'agent');
  assert.equal(message.isOwnMessage, false);
  assert.equal(message.sender, 'Kordi');
  assert.equal(message.senderOwnerName, 'You');
  assert.equal(message.planCard?.eventId, 'plan_coffee');
  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message, onOpenSenderProfile: () => {} }));
  assert.match(markup, /Owner · You/);
  assert.match(markup, /app-plan-card/);
  assert.doesNotMatch(markup, />System</);
  assert.doesNotMatch(markup, /kordi-system-avatar\.svg/);
  assert.doesNotMatch(markup, /app-chat-bubble-user/);
});

test("another member sees the card from the owner's agent with the owner line", () => {
  const message = directRow('inbound', agentCard);
  assert.equal(message.role, 'external-agent');
  assert.equal(message.sender, "Jamie Lin's Kordi");
  assert.equal(message.senderOwnerName, 'Jamie Lin');
  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message, onOpenSenderProfile: () => {} }));
  assert.match(markup, /Jamie Lin&#x27;s Kordi/);
  assert.match(markup, /Owner · Jamie Lin/);
  assert.doesNotMatch(markup, />System</);
});

test('a System agent card in a direct chat still shows as System', () => {
  const message = directRow('outbound', systemCard);
  assert.equal(message.sender, 'System');
  assert.equal(message.senderProfileImageUrl, KORDI_SYSTEM_AVATAR_URL);
  assert.equal(message.senderOwnerName, undefined);
});

test('in a group the card shows as the agent, with its picture from the agent directory', () => {
  const owner = { id: 'human:owner', kind: 'human', displayName: 'Jamie Lin', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_owner', humanId: 'acct_owner', createdAtMs: 1, updatedAtMs: 1 } as CanonicalIdentity;
  const agent = { id: 'agent:owner', kind: 'agent', displayName: 'Kordi', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'cloud-agent:acct_owner', agentId: 'cloud-agent:acct_owner', ownerIdentityId: owner.id, profileImageUrl: 'https://cdn.example/bird.png', createdAtMs: 1, updatedAtMs: 1 } as CanonicalIdentity;
  const row = (planCard: unknown): CanonicalSessionMessage => ({
    id: 'group-message:card', sessionId: 'session:group:one', senderIdentityId: owner.id, senderRole: 'person', messageKind: 'system-notice',
    contentText: '', content: { schema: 1, blocks: [], planCard }, status: 'received', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, sourceTransport: 'cloud-group',
  });
  const identities = new Map([[owner.id, owner], [agent.id, agent]]);
  const message = mapCanonicalMessage(row({ ...block, plannedBy }), identities, 'human:viewer');
  if (!message) throw new Error('expected a mapped message');
  assert.equal(message.role, 'external-agent');
  assert.equal(message.sender, "Jamie Lin's Kordi");
  assert.equal(message.senderOwnerName, 'Jamie Lin');
  assert.equal(message.senderProfileImageUrl, 'https://cdn.example/bird.png');

  const ownView = mapCanonicalMessage(row({ ...block, plannedBy }), identities, owner.id);
  assert.equal(ownView?.role, 'owned-agent');
  assert.equal(ownView?.senderOwnerName, 'You');
  assert.equal(ownView?.isOwnMessage, false);

  const system = mapCanonicalMessage(row(block), identities, 'human:viewer');
  assert.equal(system?.sender, 'System');
  assert.equal(system?.senderProfileImageUrl, KORDI_SYSTEM_AVATAR_URL);
});
