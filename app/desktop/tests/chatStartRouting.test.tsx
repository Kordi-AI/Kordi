import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { assembleMainContentSlot } from '../src/app/assembleMainContentSlot';
import { useKordiSideAgentSessionActions } from '../src/app/useKordiSideAgentSessionActions';
import { EMPTY_COMPOSER_DRAFT_STATE, type ComposerDraftState } from '../src/features/chat/composerDrafts';
import { cloudCollaborationConversationId } from '../src/features/collaboration/conversationIds';
import { assembleSidebarSlot } from '../src/app/assembleSidebarSlot';
import { buildChatsPageProps } from '../src/app/mainContentShellBuilders';
import { publishHostedProviderSnapshots } from '../src/features/cloud/hostedAccounts';
import { baseShellArgs, directAgentConversation, directPersonConversation } from './helpers/chatStartRoutingFixtures';

function baseSidebarArgs(overrides: Record<string, unknown> = {}) {
  return {
    isNativeShell: true,
    isSingleWorkspacePage: false,
    collapseChatSessions: false,
    showSessionRail: true,
    sessionRailWidth: 320,
    activeNav: 'chats',
    setActiveNav: () => {},
    chatConversations: [],
    handleCreateChatSession: async () => {},
    chatSearch: '',
    setChatSearch: () => {},
    isDesktopChatLoading: false,
    desktopChatError: null,
    filteredConversations: [],
    participantSpaces: [],
    contactParticipantSpaces: [],
    agentParticipantSpaces: [],
    activeConvId: '',
    handleSelectChatSession: async () => {},
    handleStartChatWithPerson: async () => {},
    handleStartChatWithAgent: async () => {},
    handleCreateChatGroup: async () => {},
    handleAddCollaborationContact: async () => {},
    handleCreateChatSessionInParticipantSpace: async () => {},
    handleRenameChatGroup: async () => {},
    handleAddChatGroupMembers: async () => {},
    handleRemoveChatGroupMember: async () => {},
    handleSetChatGroupAdmin: async () => {},
    handleArchiveChatSession: async () => {},
    handleDeleteChatSession: async () => {},
    handleMoveChatSessionToProject: async () => {},
    handleCreateProjectFromFolder: async () => {},
    handleCreateProject: async () => {},
    runtimeProjects: [],
    projectSearch: '',
    setProjectSearch: () => {},
    filteredProjects: [],
    activeProjectId: '',
    activeProjectSessionId: '',
    projectSelectedSessionIds: {},
    selectProject: () => {},
    expandedProjectIds: {},
    setExpandedProjectIds: () => {},
    handleSelectProjectSession: async () => {},
    groupedContacts: [],
    displayedContacts: [],
    addableContacts: [],
    contactRequests: [],
    setActiveContactGroup: () => {},
    setActiveContactId: () => {},
    displayedAgents: [],
    desktopAuthState: { hasAnyAuth: true, providers: [] },
    openAuthSettings: () => {},
    openCloudAccountAuthentication: () => {},
    activeCollaborationHost: null,
    localProfileAvatarSeed: null,
    refreshDesktopCollaboration: async () => {},
    handleCopyBridgeText: async () => {},
    handleCreateBridgeDraft: () => {},
    ...overrides,
  };
}

test('sidebar shell forwards chat create and group management handlers', () => {
  const startPerson = async () => {};
  const startAgent = async () => {};
  const createGroup = async () => {};
  const renameGroup = async () => {};
  const addMembers = async () => {};
  const removeMember = async () => {};
  const setAdmin = async () => {};
  const element = assembleSidebarSlot(baseSidebarArgs({
    handleStartChatWithPerson: startPerson,
    handleStartChatWithAgent: startAgent,
    handleCreateChatGroup: createGroup,
    handleRenameChatGroup: renameGroup,
    handleAddChatGroupMembers: addMembers,
    handleRemoveChatGroupMember: removeMember,
    handleSetChatGroupAdmin: setAdmin,
  }) as never) as never as {
    props: {
      chatActions: Record<string, unknown>;
    };
  };

  assert.equal(element.props.chatActions.onStartChatWithPerson, startPerson);
  assert.equal(typeof element.props.chatActions.onStartChatWithAgent, 'function');
  assert.equal(element.props.chatActions.onCreateChatGroup, createGroup);
  assert.equal(element.props.chatActions.onRenameChatGroup, renameGroup);
  assert.equal(element.props.chatActions.onAddChatGroupMembers, addMembers);
  assert.equal(element.props.chatActions.onRemoveChatGroupMember, removeMember);
  assert.equal(element.props.chatActions.onSetChatGroupAdmin, setAdmin);
});

test('sidebar chat-create uses the generic draft only for default Kordi', async () => {
  const calls: string[] = [];
  const element = assembleSidebarSlot(baseSidebarArgs({
    handleCreateChatSession: async () => { calls.push('createLocal'); },
    handleStartChatWithAgent: async (agent: Record<string, unknown>) => { calls.push(`startAgent:${agent.id}`); },
  }) as never) as never as {
    props: {
      chatActions: {
        onStartChatWithAgent: (agent: Record<string, unknown>) => Promise<void>;
      };
    };
  };

  await element.props.chatActions.onStartChatWithAgent({ id: 'desktop:local-agent', isOwned: true });
  await element.props.chatActions.onStartChatWithAgent({ id: 'agent:custom', isOwned: true });
  await element.props.chatActions.onStartChatWithAgent({ id: 'agent:remote', isOwned: false });

  assert.deepEqual(calls, ['createLocal', 'startAgent:agent:custom', 'startAgent:agent:remote']);
});

test('sidebar chat-create private cloud agent option routes to the selected cloud agent', async () => {
  const calls: string[] = [];
  const element = assembleSidebarSlot(baseSidebarArgs({
    handleCreateChatSession: async () => { calls.push('createLocal'); },
    handleStartChatWithAgent: async (agent: Record<string, unknown>) => { calls.push(`startCloudAgent:${agent.cloudAgentId}`); },
  }) as never) as never as {
    props: {
      chatActions: {
        onStartChatWithAgent: (agent: Record<string, unknown>) => Promise<void>;
      };
    };
  };

  await element.props.chatActions.onStartChatWithAgent({
    id: 'cloud-agent:cloud_agent_abc',
    isOwned: true,
    cloudAgentId: 'cloud_agent_abc',
    name: 'Kordi Project Driver',
  });

  assert.deepEqual(calls, ['startCloudAgent:cloud_agent_abc']);
});

test('sidebar agent creation opens Authentication before creating a session without a provider', async () => {
  const calls: string[] = [];
  const element = assembleSidebarSlot(baseSidebarArgs({
    desktopAuthState: { hasAnyAuth: false, providers: [] },
    openCloudAccountAuthentication: () => { calls.push('authentication'); },
    handleCreateChatSession: async () => { calls.push('createLocal'); },
    handleStartChatWithAgent: async () => { calls.push('startAgent'); },
  }) as never) as never as {
    props: {
      chatActions: {
        onStartChatWithAgent: (agent: Record<string, unknown>) => Promise<void>;
      };
    };
  };

  await element.props.chatActions.onStartChatWithAgent({ id: 'agent:local', isOwned: true });

  assert.deepEqual(calls, ['authentication']);
});

test('sidebar starts chats with a saved hosted account instead of reopening Authentication', async () => {
  const calls: string[] = [];
  const element = assembleSidebarSlot(baseSidebarArgs({
    desktopAuthState: { hasAnyAuth: false, providers: [] },
    openCloudAccountAuthentication: () => { calls.push('authentication'); },
    handleCreateChatSession: async () => { calls.push('createLocal'); },
    handleStartChatWithAgent: async () => { calls.push('startAgent'); },
  }) as never) as never as {
    props: { chatActions: { onStartChatWithAgent: (agent: Record<string, unknown>) => Promise<void> } };
  };
  // The login finishes after the menu was rendered; the action must use the saved account now.
  publishHostedProviderSnapshots([{
    snapshotId: 'saved', provider: 'openai-codex', authChoice: 'cloud-login:saved',
    label: 'Work', createdAt: '2026-01-01T00:00:00Z', revokedAt: null,
  }]);
  try {
    await element.props.chatActions.onStartChatWithAgent({ id: 'desktop:local-agent', isOwned: true });
    await element.props.chatActions.onStartChatWithAgent({ id: 'agent:custom', isOwned: true });
    assert.deepEqual(calls, ['createLocal', 'startAgent']);
  } finally {
    publishHostedProviderSnapshots([]);
  }
});

test('contact Message starts a fresh person session instead of selecting an existing one', () => {
  const calls: string[] = [];
  const element = assembleMainContentSlot(baseShellArgs(calls) as never) as never as { props: { contactsPageProps: { onMessageContact: (contact: Record<string, unknown>) => void } } };

  element.props.contactsPageProps.onMessageContact({
    id: 'contact-bob',
    classType: 'other-users',
    sourceHumanId: 'human-bob',
    sourceParticipantId: 'node-shared',
    sourceHostId: 'host-1',
    name: 'Bob',
    owner: 'Bob',
    sourceRuntime: 'person',
  });

  assert.deepEqual(calls, ['overlay:null', 'startPerson:host-1:node-shared:human-bob']);
});

test('contact detail delete removes the bridge contact and closes the overlay', async () => {
  const calls: string[] = [];
  const element = assembleMainContentSlot(baseShellArgs(calls, {
    handleRemoveCollaborationContact: async (hostId: string, peerNodeId: string) => {
      calls.push(`remove:${hostId}:${peerNodeId}`);
    },
  }) as never) as never as { props: { contactsPageProps: { onRemoveContact: (contact: Record<string, unknown>) => Promise<void> } } };

  await element.props.contactsPageProps.onRemoveContact({
    id: 'contact-bob',
    classType: 'other-users',
    sourceParticipantId: 'node-shared',
    sourceHostId: 'host-1',
    name: 'Bob',
  });

  assert.deepEqual(calls, ['remove:host-1:node-shared', 'overlay:null']);
});

test('agent Message starts a fresh external agent session under Saved Messages', () => {
  const calls: string[] = [];
  const element = assembleMainContentSlot(baseShellArgs(calls, {
    chatConversations: [directAgentConversation()],
  }) as never) as never as { props: { agentsPageProps: { onMessageAgent: (agent: Record<string, unknown>) => void } } };

  element.props.agentsPageProps.onMessageAgent({
    id: 'agent-bob',
    isOwned: false,
    sourceAgentId: 'agent-bob',
    sourceParticipantId: 'node-shared',
    sourceHostId: 'host-1',
    name: 'Bob agent',
    sourceRuntime: 'kordi-desktop',
  });

  assert.deepEqual(calls, ['startAgent:host-1:node-shared:agent-bob']);
});

test('private cloud-created agent Message routes to that agent instead of Kordi', () => {
  const calls: string[] = [];
  const element = assembleMainContentSlot(baseShellArgs(calls, {
    handleStartChatWithAgent: async (agent: Record<string, unknown>) => { calls.push(`startCloudAgent:${agent.cloudAgentId}`); },
  }) as never) as never as { props: { agentsPageProps: { onMessageAgent: (agent: Record<string, unknown>) => void } } };

  element.props.agentsPageProps.onMessageAgent({
    id: 'cloud-agent:cloud_agent_abc',
    cloudAgentId: 'cloud_agent_abc',
    isOwned: true,
    name: 'Kordi Project Driver',
  });

  assert.deepEqual(calls, ['startCloudAgent:cloud_agent_abc']);
});

test('external agent contact Message starts an agent session instead of routing to the person space', () => {
  const calls: string[] = [];
  const element = assembleMainContentSlot(baseShellArgs(calls, {
    chatConversations: [directPersonConversation(), directAgentConversation()],
  }) as never) as never as { props: { contactsPageProps: { onMessageContact: (contact: Record<string, unknown>) => void } } };

  element.props.contactsPageProps.onMessageContact({
    id: 'contact-bob-agent',
    classType: 'other-users-agents',
    sourceHumanId: 'human-bob',
    sourceAgentId: 'agent-bob',
    sourceParticipantId: 'node-shared',
    sourceHostId: 'host-1',
    name: 'Bob agent',
    owner: 'Bob',
    sourceRuntime: 'kordi-desktop',
  });

  assert.deepEqual(calls, ['overlay:null', 'startAgent:host-1:node-shared:agent-bob']);
});

test('Message with a draft fills only an empty composer and keeps unsent text', () => {
  let drafts: ComposerDraftState = EMPTY_COMPOSER_DRAFT_STATE;
  let setText: ReturnType<typeof useKordiSideAgentSessionActions>['setComposerTextForSession'] | null = null;
  function Probe() {
    setText = useKordiSideAgentSessionActions({
      isNativeShell: false,
      setComposerDrafts: (next) => { drafts = typeof next === 'function' ? next(drafts) : next; },
      setDesktopChatError: () => {},
      setDesktopChatState: () => {},
    }).setComposerTextForSession;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  const element = assembleMainContentSlot(baseShellArgs([], { setChatComposerTextForSession: setText }) as never) as never as {
    props: { contactsPageProps: { onMessageContact: (contact: Record<string, unknown>, options?: { draft?: string }) => void } };
  };
  const bea = { id: 'cloud-contact:acct_bea', classType: 'other-users', sourceParticipantId: 'acct_bea', sourceHostId: 'cloud', name: 'Bea', owner: 'Bea', sourceRuntime: 'person' };
  const session = cloudCollaborationConversationId('acct_bea', 'person');
  const message = (draft: string) => element.props.contactsPageProps.onMessageContact(bea, { draft });

  message('About "Plan": ');
  assert.equal(drafts.chat[session]?.text, 'About "Plan": ');
  setText!(session, 'Half-written reply');
  message('About "Notes": ');
  assert.equal(drafts.chat[session]?.text, 'Half-written reply');
  setText!(session, '  ');
  message('About "Notes": ');
  assert.equal(drafts.chat[session]?.text, 'About "Notes": ');
});

test('built-in support Message uses the stable system-contact chat route', () => {
  const calls: string[] = [];
  const element = assembleMainContentSlot(baseShellArgs(calls) as never) as never as {
    props: { contactsPageProps: { onMessageContact: (contact: Record<string, unknown>) => void } };
  };

  element.props.contactsPageProps.onMessageContact({
    id: 'cloud-contact:cloud-system:kordi-support',
    classType: 'other-users-agents',
    sourceAgentId: 'cloud_agent_kordi_support',
    sourceParticipantId: 'acct_kordi_support',
    sourceHostId: 'cloud',
    name: 'Kordi Support',
    owner: 'Kordi',
    sourceRuntime: 'kordi-desktop',
    systemContact: true,
  });

  assert.deepEqual(calls, ['overlay:null', 'startChatWithPerson']);
});



test('chat transcript contact-request hint calls Add contact for the active bridge person', async () => {
  const calls: string[] = [];
  const props = buildChatsPageProps(baseShellArgs(calls, {
    activeConv: {
      ...directPersonConversation(),
      collaborationTarget: {
        hostId: 'host-1',
        nodeId: 'node-shared',
        displayName: 'Bob',
        ownerName: 'Bob',
        runtime: 'person',
      },
    },
    handleAddCollaborationContact: async (hostId: string, peerNodeId: string) => {
      calls.push(`add:${hostId}:${peerNodeId}`);
    },
  }) as never) as never as {
    runtime: { onRequestCollaborationContact?: () => Promise<void> | void };
  };

  await props.runtime.onRequestCollaborationContact?.();

  assert.deepEqual(calls, ['add:host-1:node-shared']);
});

test('chat transcript member profile reuses the normal person-chat route', () => {
  const calls: string[] = [];
  const startPerson = async () => { calls.push('message'); };
  const props = buildChatsPageProps(baseShellArgs(calls, {
    handleStartChatWithPerson: startPerson,
  }) as never);

  assert.equal(props.runtime.onMessageContact, startPerson);
});

test('connected auth hides the auth notice while model discovery is still loading', () => {
  const props = buildChatsPageProps(baseShellArgs([], {
    desktopAuthState: {
      hasAnyAuth: true,
      providers: [],
    },
    chatModelOptions: [],
  }) as never);

  assert.equal(props.auth.hasAnyAuth, true);
});
