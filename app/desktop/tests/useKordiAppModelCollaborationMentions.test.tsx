import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCollaborationMentionTargetsByScope, mentionableCloudAgentSummaries, sharedCloudAgentOwnerIdsForMentionScope } from '../src/app/useKordiAppModelCollaborationMentions';
import type { Conversation, DesktopCollaborationState, DesktopChatState } from '../src/kordi-app/types';

function collaborationState(): DesktopCollaborationState {
  return {
    activeHostId: 'host-1',
    hosts: [{
      id: 'host-1',
      registered: true,
      connected: true,
      serverUrl: 'https://bridge.test',
      nodeId: 'node-local',
      displayName: 'Alice Kordi',
      ownerName: 'Alice',
      endpoint: 'https://alice.example',
      tokenPresent: true,
      humanId: 'human-alice',
      discoveryMode: 'manual',
      activeAgentId: 'agent-local',
      agents: [{
        id: 'agent-local',
        label: 'Kordi',
        nodeId: 'node-agent-local',
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
      label: 'BabyTREE',
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

test('buildCollaborationMentionTargetsByScope returns empty targets outside the native shell', () => {
  const targets = buildCollaborationMentionTargetsByScope({
    isNativeShell: false,
    desktopCollaborationState: null,
    desktopChatState: null,
    activeConvMentionScope: null,
  });

  assert.deepEqual(targets, { chat: [], project: [] });
});

test('buildCollaborationMentionTargetsByScope exposes product-facing mention detail copy and avatars', () => {
  const state = collaborationState();
  state.hosts[0].profileImageUrl = 'https://images.test/alice.png';
  state.hosts[0].visiblePeers = [
    {
      endpoint: 'https://bob.example',
      nodeId: 'node-bob',
      displayName: 'Bob',
      ownerName: 'Bob',
      runtime: 'person',
      humanId: 'human-bob',
      agentId: null,
      isContact: true,
      contactRequestStatus: 'approved',
      sharedProjects: [],
      profileImageUrl: 'https://images.test/bob.png',
    },
    {
      endpoint: 'https://bob.example',
      nodeId: 'node-bob-agent',
      displayName: "Bob's Kordi",
      ownerName: 'Bob',
      runtime: 'kordi-desktop',
      humanId: 'human-bob',
      agentId: 'agent-bob',
      isDefaultAgent: true,
      isContact: true,
      contactRequestStatus: 'approved',
      sharedProjects: [],
      profileImageUrl: 'https://images.test/bob-agent.png',
    },
  ];

  const targets = buildCollaborationMentionTargetsByScope({
    isNativeShell: true,
    desktopCollaborationState: state,
    desktopChatState: desktopChatState(),
    activeConvMentionScope: null,
  });

  const localAgent = targets.chat.find((target) => target.label === 'BabyTREE');
  const person = targets.chat.find((target) => target.label === 'Bob' && target.targetKind === 'person');
  const agent = targets.chat.find((target) => target.label === "Bob's Kordi" && target.targetKind === 'agent');

  assert.equal(localAgent?.detail, 'Owner · You');
  assert.equal(localAgent?.avatarImageUrl, 'https://images.test/alice.png');
  assert.equal(person?.detail, 'Person');
  assert.equal(person?.avatarImageUrl, 'https://images.test/bob.png');
  assert.equal(agent?.detail, 'Owner · Bob');
  assert.equal(agent?.avatarImageUrl, 'https://images.test/bob-agent.png');
  for (const target of targets.chat) {
    assert.doesNotMatch(target.detail ?? '', /Bridge|Owner:|kordi-desktop/i);
  }
});

test('buildCollaborationMentionTargetsByScope carries unread count for matching mention participants', () => {
  const state = collaborationState();
  state.hosts[0].visiblePeers = [{
    endpoint: 'https://bob.example',
    nodeId: 'node-bob',
    displayName: 'Bob',
    ownerName: 'Bob',
    runtime: 'person',
    humanId: 'human-bob',
    agentId: null,
    isContact: true,
    contactRequestStatus: 'approved',
    sharedProjects: [],
  }];
  const conversations: Conversation[] = [{
    id: 'bridge:host-1:node-bob:person',
    canonicalSessionId: 'bridge:host-1:node-bob:person',
    name: 'Bob',
    type: 'person',
    subtitle: 'Unread hello',
    unread: 3,
    collaborationSources: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct chat',
    participants: ['Alice', 'Bob'],
    messages: [],
    collaborationTarget: { hostId: 'host-1', nodeId: 'node-bob', humanId: 'human-bob', runtime: 'person' },
  }];

  const targets = buildCollaborationMentionTargetsByScope({
    isNativeShell: true,
    desktopCollaborationState: state,
    desktopChatState: desktopChatState(),
    activeConvMentionScope: null,
    conversations,
  });

  assert.equal(targets.chat.find((target) => target.nodeId === 'node-bob')?.unreadCount, 3);
});

test('buildCollaborationMentionTargetsByScope includes the scoped local Bridge agent', () => {
  const targets = buildCollaborationMentionTargetsByScope({
    isNativeShell: true,
    desktopCollaborationState: collaborationState(),
    desktopChatState: desktopChatState(),
    activeConvMentionScope: null,
  });

  assert.equal(targets.chat[0]?.label, 'BabyTREE');
  assert.equal(targets.chat[0]?.value, 'BabyTREEAlice');
  assert.equal(targets.chat[0]?.targetKind, 'agent');
  assert.equal(targets.chat[0]?.nodeId, 'node-agent-local');
  assert.equal(targets.project[0]?.label, 'BabyTREE');
});

test('buildCollaborationMentionTargetsByScope hides chat mentions in direct agent sessions', () => {
  const targets = buildCollaborationMentionTargetsByScope({
    isNativeShell: true,
    desktopCollaborationState: collaborationState(),
    desktopChatState: desktopChatState(),
    activeConvMentionScope: {
      id: 'session:agent',
      canonicalSessionId: 'session:agent',
      name: 'My Kordi',
      type: 'owned-agent',
      subtitle: '',
      unread: 0,
      collaborationSources: ['Local'],
      trust: 'Owned',
      directness: 'Direct chat',
      participants: ['Me', 'My Kordi'],
      messages: [],
    } as Conversation,
  });

  assert.deepEqual(targets.chat, []);
  assert.equal(targets.project[0]?.label, 'BabyTREE');
});

test('mentionableCloudAgentSummaries merges owned shared Cloud Agents for owner autocomplete and send resolution', () => {
  const summaries = mentionableCloudAgentSummaries({
    sharedCloudAgents: [{
      agentId: 'cloud_agent_remote',
      ownerAccountId: 'acct_remote',
      ownerDisplayName: 'Remote',
      accessScope: 'participant_conversations',
      name: 'Remote Driver',
      role: 'Remote helper',
      description: null,
      updatedAt: '2026-06-20T00:00:00Z',
    }],
    ownedCloudAgentsById: {
      cloud_agent_private: {
        agentId: 'cloud_agent_private',
        ownerAccountId: 'acct_me',
        accessScope: 'private',
        status: 'active',
        name: 'Private Notes',
        role: 'Private helper',
        description: null,
        systemPrompt: 'private prompt',
        sourceSummary: null,
        boundaries: [],
        resources: [],
        skills: [],
        modelRouting: {},
        createdAt: '2026-06-20T00:00:00Z',
        updatedAt: '2026-06-20T00:00:00Z',
        archivedAt: null,
      },
      cloud_agent_project: {
        agentId: 'cloud_agent_project',
        ownerAccountId: 'acct_me',
        accessScope: 'participant_conversations',
        status: 'active',
        name: 'Kordi Project Driver',
        role: 'Project helper',
        description: 'Moves work forward',
        systemPrompt: 'secret prompt',
        sourceSummary: null,
        boundaries: [],
        resources: [],
        skills: [],
        modelRouting: { defaultModel: 'private/model' },
        createdAt: '2026-06-20T00:00:00Z',
        updatedAt: '2026-06-20T00:01:00Z',
        archivedAt: null,
      },
    },
    ownerDisplayName: '111',
  });

  assert.deepEqual(
    summaries.map((agent) => `${agent.ownerDisplayName}:${agent.name}:${agent.agentId}`),
    ['Remote:Remote Driver:cloud_agent_remote', '111:Kordi Project Driver:cloud_agent_project'],
  );
  assert.equal('systemPrompt' in (summaries[1] as object), false);
  assert.equal('modelRouting' in (summaries[1] as object), false);
});

test('buildCollaborationMentionTargetsByScope includes shared hosted Cloud Agents for conversation participants', () => {
  const state = collaborationState();
  state.activeHostId = 'cloud';
  state.hosts = [{
    ...state.hosts[0],
    id: 'cloud',
    nodeId: 'acct_me',
    humanId: 'acct_me',
    ownerName: '222',
    displayName: '222',
    agents: [{
      ...state.hosts[0].agents[0],
      id: 'cloud-local-agent',
      nodeId: 'acct_me',
      runtime: 'kordi-desktop',
    }],
    visiblePeers: [],
    visiblePeerCount: 0,
  }];
  const group = {
    id: 'session:group:cloud',
    canonicalSessionId: 'session:group:cloud',
    name: 'Cloud group',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    collaborationSources: ['cloud'],
    trust: 'Cloud',
    directness: 'Group chat',
    participantSpaceId: 'group:cloud',
    participants: ['222', '111'],
    canonicalParticipants: [
      { id: 'human:acct_me', name: '222', kind: 'human', role: 'self', source: 'local', humanId: 'acct_me', sourceIdentityId: 'acct_me' },
      { id: 'human:acct_owner', name: '111', kind: 'human', role: 'person', source: 'bridge', sourceHostId: 'cloud', humanId: 'acct_owner', sourceIdentityId: 'acct_owner', profileImageUrl: 'https://images.test/111.png' },
    ],
    messages: [],
  } as Conversation;

  const targets = buildCollaborationMentionTargetsByScope({
    isNativeShell: true,
    desktopCollaborationState: state,
    desktopChatState: desktopChatState(),
    activeConvMentionScope: group,
    sharedCloudAgents: [{
      agentId: 'cloud_agent_project',
      ownerAccountId: 'acct_owner',
      ownerDisplayName: '111',
      accessScope: 'participant_conversations',
      name: 'Kordi Project Driver',
      role: 'Project helper',
      description: null,
      updatedAt: '2026-06-20T00:00:00Z',
    }],
  });

  const projectDriver = targets.chat.find((target) => target.agentId === 'cloud_agent_project');
  assert.equal(projectDriver?.label, 'Kordi Project Driver');
  assert.equal(projectDriver?.value, 'KordiProjectDriver');
  assert.equal(projectDriver?.sourceHostId, 'cloud');
  assert.equal(projectDriver?.nodeId, 'acct_owner');
  assert.equal(projectDriver?.ownerName, '111');
  assert.equal(projectDriver?.detail, 'Owner · 111');
  assert.equal(projectDriver?.avatarImageUrl, 'https://images.test/111.png');
});

test('sharedCloudAgentOwnerIdsForMentionScope uses direct contact bridge targets when canonical participants are absent', () => {
  assert.deepEqual(sharedCloudAgentOwnerIdsForMentionScope({
    id: 'bridge:cloud:acct_owner:person',
    canonicalSessionId: 'bridge:cloud:acct_owner:person',
    type: 'person',
    directness: 'Direct chat',
    participants: ['222', '111'],
    collaborationTarget: { hostId: 'cloud', nodeId: 'acct_owner', humanId: 'acct_owner', runtime: 'person' },
  } as Conversation, 'acct_me'), ['acct_owner']);
});

test('buildCollaborationMentionTargetsByScope includes my owned shared Cloud Agent in direct contact chats', () => {
  const state = collaborationState();
  state.activeHostId = 'cloud';
  state.hosts = [{
    ...state.hosts[0],
    id: 'cloud',
    nodeId: 'acct_me',
    humanId: 'acct_me',
    ownerName: '111',
    displayName: '111',
    agents: [{
      ...state.hosts[0].agents[0],
      id: 'cloud-local-agent',
      nodeId: 'acct_me',
      runtime: 'kordi-desktop',
    }],
    visiblePeers: [],
    visiblePeerCount: 0,
  }];
  const directContact = {
    id: 'bridge:cloud:acct_222:person',
    canonicalSessionId: 'bridge:cloud:acct_222:person',
    name: '222',
    type: 'person',
    subtitle: '',
    unread: 0,
    collaborationSources: ['cloud'],
    trust: 'Cloud',
    directness: 'Direct chat',
    participants: ['111', '222'],
    collaborationTarget: { hostId: 'cloud', nodeId: 'acct_222', humanId: 'acct_222', ownerName: '222', runtime: 'person' },
    messages: [],
  } as Conversation;

  const targets = buildCollaborationMentionTargetsByScope({
    isNativeShell: true,
    desktopCollaborationState: state,
    desktopChatState: desktopChatState(),
    activeConvMentionScope: directContact,
    sharedCloudAgents: [{
      agentId: 'cloud_agent_project',
      ownerAccountId: 'acct_me',
      ownerDisplayName: '111',
      accessScope: 'participant_conversations',
      name: 'Kordi Project Driver',
      role: 'Project helper',
      description: null,
      updatedAt: '2026-06-20T00:00:00Z',
    }],
  });

  const projectDriver = targets.chat.find((target) => target.agentId === 'cloud_agent_project');
  assert.equal(projectDriver?.label, 'Kordi Project Driver');
  assert.equal(projectDriver?.value, 'KordiProjectDriver');
  assert.equal(projectDriver?.nodeId, 'acct_me');
});

test('buildCollaborationMentionTargetsByScope includes shared hosted Cloud Agents in direct contact chats with the owner', () => {
  const state = collaborationState();
  state.activeHostId = 'cloud';
  state.hosts = [{
    ...state.hosts[0],
    id: 'cloud',
    nodeId: 'acct_me',
    humanId: 'acct_me',
    ownerName: '222',
    displayName: '222',
    agents: [{
      ...state.hosts[0].agents[0],
      id: 'cloud-local-agent',
      nodeId: 'acct_me',
      runtime: 'kordi-desktop',
    }],
    visiblePeers: [],
    visiblePeerCount: 0,
  }];
  const directContact = {
    id: 'bridge:cloud:acct_owner:person',
    canonicalSessionId: 'bridge:cloud:acct_owner:person',
    name: '111',
    type: 'person',
    subtitle: '',
    unread: 0,
    collaborationSources: ['cloud'],
    trust: 'Cloud',
    directness: 'Direct person chat',
    participants: ['222', '111'],
    collaborationTarget: { hostId: 'cloud', nodeId: 'acct_owner', humanId: 'acct_owner', ownerName: '111', runtime: 'person', agentId: null },
    messages: [],
  } as Conversation;

  const targets = buildCollaborationMentionTargetsByScope({
    isNativeShell: true,
    desktopCollaborationState: state,
    desktopChatState: desktopChatState(),
    activeConvMentionScope: directContact,
    sharedCloudAgents: [{
      agentId: 'cloud_agent_project',
      ownerAccountId: 'acct_owner',
      ownerDisplayName: '111',
      accessScope: 'participant_conversations',
      name: 'Kordi Project Driver',
      role: 'Project helper',
      description: null,
      updatedAt: '2026-06-20T00:00:00Z',
    }],
  });

  const projectDriver = targets.chat.find((target) => target.agentId === 'cloud_agent_project');
  assert.equal(projectDriver?.label, 'Kordi Project Driver');
  assert.equal(projectDriver?.nodeId, 'acct_owner');
  assert.equal(projectDriver?.ownerName, '111');
});

test('buildCollaborationMentionTargetsByScope includes group-only people but only reachable agents', () => {
  const state = collaborationState();
  state.activeHostId = 'cloud';
  state.hosts = [{
    ...state.hosts[0],
    id: 'cloud',
    nodeId: 'acct_me',
    humanId: 'acct_me',
    ownerName: 'Me Cloud',
    displayName: 'Me Cloud',
    agents: [{
      ...state.hosts[0].agents[0],
      id: 'cloud-local-agent',
      nodeId: 'acct_me',
      runtime: 'kordi-desktop',
    }],
    visiblePeers: [{
      endpoint: 'cloud',
      nodeId: 'acct_alice',
      displayName: "Alice's Kordi",
      ownerName: 'Alice',
      runtime: 'kordi-desktop',
      humanId: 'acct_alice',
      agentId: 'cloud-agent:acct_alice',
      isDefaultAgent: true,
      isContact: true,
      contactRequestStatus: 'approved',
      sharedProjects: [],
    }],
    visiblePeerCount: 1,
  }];
  const group = {
    id: 'session:group:cloud',
    canonicalSessionId: 'session:group:cloud',
    name: 'Cloud group',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    collaborationSources: ['cloud'],
    trust: 'Cloud',
    directness: 'Group chat',
    participantSpaceId: 'group:cloud',
    participants: ['Me Cloud', 'Alice', 'Bob'],
    canonicalParticipants: [
      { id: 'human:acct_me', name: 'Me Cloud', kind: 'human', role: 'self', source: 'local', humanId: 'acct_me', sourceIdentityId: 'acct_me' },
      { id: 'human:acct_alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', sourceHostId: 'cloud', humanId: 'acct_alice', sourceIdentityId: 'acct_alice' },
      { id: 'human:acct_bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', sourceHostId: 'cloud', humanId: 'acct_bob', sourceIdentityId: 'acct_bob' },
    ],
    messages: [],
  } as Conversation;

  const targets = buildCollaborationMentionTargetsByScope({
    isNativeShell: true,
    desktopCollaborationState: state,
    desktopChatState: desktopChatState(),
    activeConvMentionScope: group,
  });

  assert.deepEqual(
    targets.chat.map((target) => `${target.targetKind}:${target.label}:${target.nodeId}`),
    [
      'all:All:group:session:group:cloud',
      'agent:BabyTREE:acct_me',
      'person:Alice:acct_alice',
      "agent:Alice's Kordi:acct_alice",
      'person:Bob:acct_bob',
    ],
  );
  assert.equal(targets.chat[0]?.detail, 'All people in this group');
  assert.equal(targets.project.some((target) => target.targetKind === 'all'), false);
  assert.equal(targets.chat.some((target) => target.label === "Bob's Kordi"), false);
});

function nonContactGroup(): { state: DesktopCollaborationState; group: Conversation } {
  const state = collaborationState();
  state.activeHostId = 'cloud';
  state.hosts = [{
    ...state.hosts[0],
    id: 'cloud',
    nodeId: 'acct_bea',
    humanId: 'acct_bea',
    ownerName: 'Bea',
    displayName: 'Bea',
    agents: [{ ...state.hosts[0].agents[0], id: 'cloud-local-agent', nodeId: 'acct_bea', runtime: 'kordi-desktop' }],
    // Bea joined from a Grounding room invitation: Alex is not a contact.
    visiblePeers: [],
    visiblePeerCount: 0,
  }];
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
      rendererVersion: 'test',
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
  assert.equal(agents.length, 2);
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
