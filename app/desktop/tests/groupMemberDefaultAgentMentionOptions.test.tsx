import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCollaborationMentionTargetsByScope } from '../src/app/useKordiAppModelCollaborationMentions';
import { CANONICAL_AVATAR_RENDERER_VERSION } from '../src/features/cloud/canonicalAvatar';
import type { Conversation, DesktopCollaborationState, DesktopChatState } from '../src/kordi-app/types';

// People in the owner's group chats can mention the default agent without
// being contacts (docs/contact-permissions.md).

function collaborationState(): DesktopCollaborationState {
  return {
    activeHostId: 'cloud',
    hosts: [{
      id: 'cloud',
      registered: true,
      connected: true,
      serverUrl: 'https://cloud.test',
      nodeId: 'acct_bea',
      displayName: 'Bea',
      ownerName: 'Bea',
      endpoint: 'cloud',
      tokenPresent: true,
      humanId: 'acct_bea',
      discoveryMode: 'manual',
      activeAgentId: 'cloud-local-agent',
      agents: [{
        id: 'cloud-local-agent',
        label: 'Kordi',
        nodeId: 'acct_bea',
        runtime: 'kordi-desktop',
        isDefault: true,
        isActive: true,
        registered: true,
      }],
      visiblePeers: [],
      visiblePeerCount: 0,
      projects: [],
    }],
    conversations: [],
  };
}

function desktopChatState(): DesktopChatState {
  return {
    localAgent: {
      label: 'Kordi',
      systemPrompt: '',
      loadedSkills: [],
      loadedTools: [],
      loadedPlugins: [],
      identityFiles: [],
      defaultProvider: '',
      defaultModel: '',
      workspaceRoot: '',
      lastActivities: [],
    },
  } as DesktopChatState;
}

function nonContactGroup(): { state: DesktopCollaborationState; group: Conversation } {
  const state = collaborationState();
  const group = {
    id: 'session:group:room',
    canonicalSessionId: 'session:group:room',
    name: 'Room group',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    collaborationSources: ['cloud'],
    trust: 'Cloud',
    directness: 'Group chat',
    participantSpaceId: 'group:room',
    participants: ['Bea', 'Alex Rivera'],
    canonicalParticipants: [
      { id: 'human:acct_bea', name: 'Bea', kind: 'human', role: 'self', source: 'local', humanId: 'acct_bea', sourceIdentityId: 'acct_bea' },
      { id: 'human:acct_alex', name: 'Alex Rivera', kind: 'human', role: 'person', source: 'bridge', sourceHostId: 'cloud', humanId: 'acct_alex', sourceIdentityId: 'acct_alex' },
    ],
    messages: [],
  } as Conversation;
  return { state, group };
}

function defaultAgentSummary(ownerAccountId: string, ownerDisplayName: string) {
  return {
    agentId: `cloud-agent:${ownerAccountId}`,
    ownerAccountId,
    ownerDisplayName,
    accessScope: 'participant_conversations' as const,
    name: 'Kordi',
    role: 'Default agent',
    description: null,
    avatarUrl: null,
    avatar: {
      entityType: 'agent',
      entityId: `cloud-agent:${ownerAccountId}`,
      source: 'generated' as const,
      style: 'thumbs' as const,
      seed: `default-agent-${ownerAccountId}`,
      rendererVersion: CANONICAL_AVATAR_RENDERER_VERSION,
      uploadedAsset: null,
      version: 1,
      updatedAt: '2026-11-13T00:00:00Z',
    },
    updatedAt: '2026-11-13T00:00:00Z',
    isDefaultAgent: true,
  };
}

test('buildCollaborationMentionTargetsByScope offers a non-contact group member’s default agent', () => {
  const { state, group } = nonContactGroup();
  const targets = buildCollaborationMentionTargetsByScope({
    isNativeShell: true,
    desktopCollaborationState: state,
    desktopChatState: desktopChatState(),
    activeConvMentionScope: group,
    sharedCloudAgents: [defaultAgentSummary('acct_alex', 'Alex Rivera'), defaultAgentSummary('acct_bea', 'Bea')],
  });

  const agents = targets.chat.filter((target) => target.targetKind === 'agent');
  const alexAgent = agents.find((target) => target.agentId === 'cloud-agent:acct_alex');
  assert.equal(alexAgent?.label, "Alex Rivera's Kordi");
  assert.equal(alexAgent?.detail, 'Owner · Alex Rivera');
  assert.equal(alexAgent?.humanId, 'acct_alex');
  // The viewer's own default agent stays the local agent, listed once.
  assert.equal(agents.some((target) => target.agentId === 'cloud-agent:acct_bea'), false);
  // The Facilitator leads the agents in every group, then the local agent and Alex's.
  assert.equal(agents[0]?.label, 'Facilitator');
  assert.equal(agents.length, 3);
  // Outside group chats, a default agent comes only from the contact list.
  const projectTargets = targets.project.filter((target) => target.targetKind === 'agent' && target.agentId === 'cloud-agent:acct_alex');
  assert.equal(projectTargets.length, 0);
});

test('buildCollaborationMentionTargetsByScope lists a contact’s default agent once', () => {
  const { state, group } = nonContactGroup();
  state.hosts[0].visiblePeers = [{
    endpoint: 'cloud',
    nodeId: 'acct_alex',
    displayName: "Alex Rivera's Kordi",
    ownerName: 'Alex Rivera',
    runtime: 'kordi-desktop',
    humanId: 'acct_alex',
    agentId: 'cloud-agent:acct_alex',
    isDefaultAgent: true,
    isContact: true,
    contactRequestStatus: 'approved',
    sharedProjects: [],
  }];
  state.hosts[0].visiblePeerCount = 1;
  const targets = buildCollaborationMentionTargetsByScope({
    isNativeShell: true,
    desktopCollaborationState: state,
    desktopChatState: desktopChatState(),
    activeConvMentionScope: group,
    sharedCloudAgents: [defaultAgentSummary('acct_alex', 'Alex Rivera')],
  });
  const alexAgents = targets.chat.filter((target) => target.targetKind === 'agent' && target.agentId === 'cloud-agent:acct_alex');
  assert.equal(alexAgents.length, 1);
  assert.equal(alexAgents[0]?.sourceHostId, 'cloud');
  assert.equal(alexAgents[0]?.runtime, 'kordi-desktop');
});
