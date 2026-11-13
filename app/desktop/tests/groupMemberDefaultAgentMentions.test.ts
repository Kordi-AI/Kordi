import assert from 'node:assert/strict';
import test from 'node:test';

import { cloudAgentMentionIdentity } from '../src/features/chat/messageActions/cloudAgentMentionTarget';
import { resolveMentionedCollaborationTarget, sharedCloudAgentMentionCandidatesForConversation } from '../src/features/chat/messageActions/mentions';
import { CANONICAL_AVATAR_RENDERER_VERSION } from '../src/features/cloud/canonicalAvatar';
import { normalizeSharedCloudAgentSummary, type SharedCloudAgentSummary } from '../src/features/cloud/cloudAgents';
import type { Conversation, DesktopCollaborationState } from '../src/kordi-app/types';

// People in the owner's group chats can mention the default agent without
// being contacts (docs/contact-permissions.md).

const alexDefaultAgent = normalizeSharedCloudAgentSummary({
  agentId: 'cloud-agent:acct_alex',
  ownerAccountId: 'acct_alex',
  ownerDisplayName: 'Alex Rivera',
  accessScope: 'participant_conversations',
  name: 'Kordi',
  role: 'Default agent',
  description: null,
  avatarUrl: null,
  avatar: {
    entityType: 'agent', entityId: 'cloud-agent:acct_alex', source: 'generated', style: 'thumbs',
    seed: 'default-agent-acct_alex', rendererVersion: CANONICAL_AVATAR_RENDERER_VERSION, uploadedAsset: null, version: 1,
    updatedAt: '2026-11-13T00:00:00Z',
  },
  updatedAt: '2026-11-13T00:00:00Z',
  isDefaultAgent: true,
}) as SharedCloudAgentSummary;

const viewer: DesktopCollaborationState = {
  activeHostId: 'cloud',
  hosts: [{
    id: 'cloud', registered: true, connected: true, serverUrl: 'https://cloud.test', nodeId: 'acct_bea',
    displayName: 'Bea', ownerName: 'Bea', endpoint: 'cloud', tokenPresent: true, humanId: 'acct_bea',
    discoveryMode: 'manual', activeAgentId: 'cloud-local-agent', agents: [], visiblePeers: [],
    visiblePeerCount: 0, projects: [],
  }],
  conversations: [],
} as unknown as DesktopCollaborationState;

const participants = [
  { id: 'human:acct_bea', name: 'Bea', kind: 'human', role: 'self', source: 'local', humanId: 'acct_bea', sourceIdentityId: 'acct_bea' },
  { id: 'human:acct_alex', name: 'Alex Rivera', kind: 'human', role: 'person', source: 'bridge', sourceHostId: 'cloud', humanId: 'acct_alex', sourceIdentityId: 'acct_alex' },
];

const group = {
  id: 'session:group:room', canonicalSessionId: 'session:group:room', directness: 'Group chat',
  participantSpaceId: 'group:room', participants: ['Bea', 'Alex Rivera'], canonicalParticipants: participants,
} as unknown as Conversation;

const direct = {
  id: 'bridge:cloud:acct_alex:person', canonicalSessionId: 'session:direct:acct_alex', directness: 'Direct contact',
  participants: ['Bea', 'Alex Rivera'], canonicalParticipants: participants,
} as unknown as Conversation;

test('the shared agent list keeps the default-agent flag', () => {
  assert.equal(alexDefaultAgent.isDefaultAgent, true);
  const factory = normalizeSharedCloudAgentSummary({ ...alexDefaultAgent, agentId: 'cloud_agent_x', isDefaultAgent: undefined });
  assert.equal(factory?.isDefaultAgent, undefined);
});

test('a group member’s default agent is mentionable in the group, not in a direct chat', () => {
  const inGroup = sharedCloudAgentMentionCandidatesForConversation([alexDefaultAgent], group, 'acct_bea');
  assert.deepEqual(inGroup.map((candidate) => [candidate.displayLabel, candidate.handle]), [["Alex Rivera's Kordi", 'AlexRiverasKordi']]);
  assert.deepEqual(sharedCloudAgentMentionCandidatesForConversation([alexDefaultAgent], direct, 'acct_bea'), []);
});

test('a typed mention of a group member’s default agent targets that agent', () => {
  const target = resolveMentionedCollaborationTarget('@AlexRiverasKordi summarize the plan', viewer, group, {
    targetKind: 'agent',
    sharedCloudAgents: [alexDefaultAgent],
    localAccountId: 'acct_bea',
  });
  assert.equal(target?.peer.agentId, 'cloud-agent:acct_alex');
  assert.equal(target?.requestText, 'summarize the plan');
  assert.deepEqual(cloudAgentMentionIdentity(target ?? null), {
    targetCloudAgentId: 'cloud-agent:acct_alex',
    targetCloudAgentName: 'Kordi',
    ownerAccountId: 'acct_alex',
  });
});
