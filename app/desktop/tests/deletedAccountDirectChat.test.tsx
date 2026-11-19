import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { addCollaborationPeerContacts } from '../src/app/viewModels/collaborationPeerContacts';
import {
  isClosedConversation,
  isClosedParticipantSpace,
  isDeletedAccountConversation,
  isGroupClosedError,
  PEER_ACCOUNT_DELETED_LINE,
} from '../src/features/chat/closedGroup';
import { terminalCollaborationSendFailure } from '../src/features/chat/messageActions/collaborationSendLifecycle';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { cloudMessageFromChatSync, conversationPeer } from '../src/features/cloud/chatSyncMapping';
import { ChatSyncState } from '../src/features/cloud/chatSyncState';
import { ChatSyncSyncClient } from '../src/features/cloud/chatSyncSyncClient';
import type { ChatSyncConversation, ChatSyncEvent, ChatSyncMessage } from '../src/features/cloud/chatSyncTypes';
import { buildCloudAuthError } from '../src/features/cloud/cloudAuthError';
import { applyCloudSyncEventsToMessagesByPeer } from '../src/features/cloud/cloudDiffSyncMessages';
import { CloudMessageDeletions } from '../src/features/cloud/cloudMessageDeletions';
import { buildCloudDesktopCollaborationState } from '../src/features/cloud/cloudCollaborationState';
import {
  cloudDeletedDirectConversation,
  cloudDeletedDirectConversations,
  deletedDirectPeerAccountId,
  publishCloudDeletedDirectConversations,
  useCloudDeletedDirectConversations,
  withDeletedDirectRefusals,
} from '../src/features/cloud/cloudDeletedDirectCatalog';
import { buildCloudDeletedDirectChats, withCloudDeletedDirectChats } from '../src/features/cloud/cloudDeletedDirectState';
import { cloudPersonInfoPeerAccountId } from '../src/features/cloud/cloudDirectChatPeer';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { createCollaborationConversationMapper } from '../src/features/collaboration/conversationProjectionCache';
import { cloudCollaborationConversationId } from '../src/features/collaboration/conversationIds';
import type { Contact, Conversation } from '../src/kordi-app/types';
import { ChatDetailPanel } from '../src/pages/ChatDetailPanel';
import { closedConversationComposer } from '../src/pages/closedConversationComposer';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import { installDom } from './helpers/transcriptAttachmentDom';
import { baseSidebarProps } from './helpers/workspaceSidebarParticipantSpacesFixtures';

const VIEWER = 'acct_rowan';
const GONE = 'acct_dana';
const LEE = 'acct_lee';
const STAND_IN = 'acct_kordi_deleted';
const SESSION_ID = `session:direct-person:${GONE}:${VIEWER}`;
const CLOSED_AT = '2026-11-18T10:00:00Z';

const account: CloudAccount = {
  accountId: VIEWER,
  displayName: 'Rowan Sample',
  primaryEmail: 'rowan@example.test',
  avatarUrl: null,
  avatar: {
    entityType: 'human', entityId: VIEWER, source: 'generated', style: 'lorelei', seed: VIEWER,
    rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0', uploadedAsset: null, version: 1,
    updatedAt: '2026-11-01T00:00:00Z',
  },
  nodeId: 'node_rowan',
  passwordSet: true,
};

function member(accountId: string, state: 'active' | 'left' | 'removed', role = 'member') {
  return {
    account_id: accountId, role, membership_state: state, version: 1,
    last_delivered_sequence: 2, last_read_sequence: 2,
    joined_at: '2026-11-01T09:00:00Z', left_at: state === 'active' ? null : CLOSED_AT,
  };
}

function directConversation(overrides: Partial<ChatSyncConversation> = {}): ChatSyncConversation {
  return {
    id: '019d0000-0000-7000-8000-000000000001',
    kind: 'direct',
    shared_title: null,
    version: 5,
    created_by_account_id: VIEWER,
    legacy_session_id: SESSION_ID,
    latest_message_sequence: 2,
    created_at: '2026-11-01T09:00:00Z',
    updated_at: '2026-11-18T09:59:59Z',
    members: [member(VIEWER, 'active', 'owner'), member(STAND_IN, 'left')],
    closed: { closed_at: CLOSED_AT, closed_by_account_id: STAND_IN },
    preferences: { conversation_id: '019d0000-0000-7000-8000-000000000001', account_id: VIEWER, personal_title: null, version: 1 },
    ...overrides,
  };
}

const kept = directConversation();

function chatMessage(sequence: number, sender: string, text: string, createdAt: string): ChatSyncMessage {
  return {
    id: `019d0000-0000-7000-8000-00000000010${sequence}`,
    client_message_id: `019d0000-0000-7000-8000-00000000020${sequence}`,
    conversation_id: kept.id,
    conversation_sequence: sequence,
    sender_account_id: sender,
    kind: 'text',
    content: { schema: 1, blocks: [{ type: 'text', text }] },
    reply_to_message_id: null,
    attachment_ids: [],
    version: 2,
    generation_status: null,
    provider_response_id: null,
    created_at: createdAt,
    edited_at: null,
    deleted_at: null,
    reactions: [],
  };
}

const fromStandIn = chatMessage(1, STAND_IN, 'See you at the station', '2026-11-17T08:00:00Z');
const fromViewer = chatMessage(2, VIEWER, 'Thanks, see you there', '2026-11-17T08:05:00Z');

function messagesByPeerFor(messages: ChatSyncMessage[], conversation = kept) {
  const byPeer: Record<string, CloudMessage[]> = {};
  for (const snapshot of messages) {
    const message = cloudMessageFromChatSync(snapshot, conversation, VIEWER);
    const peer = message.fromAccountId === VIEWER ? message.toAccountId : message.fromAccountId;
    (byPeer[peer] ??= []).push(message);
  }
  return byPeer;
}

const entry = cloudDeletedDirectConversation(kept, VIEWER)!;

function deletedChatState(contacts: Contact[] = [], extraMessages: Record<string, CloudMessage[]> = {}) {
  const messagesByPeer = { ...messagesByPeerFor([fromStandIn, fromViewer]), ...extraMessages };
  const messageIndex = buildCloudMessageIndex(account.accountId, messagesByPeer);
  return withCloudDeletedDirectChats(
    buildCloudDesktopCollaborationState({ account, contacts, messagesByPeer, messageIndex }),
    buildCloudDeletedDirectChats({ account, entries: [entry], messagesByPeer, messageIndex }),
  );
}

function deletedChatViewModel(): Conversation {
  const state = deletedChatState();
  const chat = state.conversations.find((conversation) => conversation.id === cloudCollaborationConversationId(GONE, 'person'));
  assert.ok(chat);
  return createCollaborationConversationMapper()(chat, state.hosts[0], 'Kordi');
}

const closedResponse = () => buildCloudAuthError(409, {
  error: { code: 'group_closed', message: 'This group was closed.' },
}, 'Could not send message.');

test('a kept direct conversation is found by its session id and the missing member row', () => {
  assert.equal(deletedDirectPeerAccountId(kept, VIEWER), GONE);
  // The member change reaches the device before the close, in the same batch.
  assert.equal(deletedDirectPeerAccountId(directConversation({ closed: null, members: [member(VIEWER, 'active', 'owner')] }), VIEWER), GONE);
  assert.equal(deletedDirectPeerAccountId(directConversation({ closed: null, members: [member(VIEWER, 'active'), member(GONE, 'active')] }), VIEWER), null);
  assert.equal(deletedDirectPeerAccountId(directConversation({ kind: 'group' }), VIEWER), null);
  assert.equal(deletedDirectPeerAccountId(directConversation({ legacy_session_id: `session:direct-person:acct_kordi_pip:${VIEWER}` }), VIEWER), null);
  assert.equal(deletedDirectPeerAccountId(kept, 'acct_someone_else'), null);
  assert.deepEqual(entry, { conversationId: kept.id, sessionId: SESSION_ID, peerAccountId: GONE, closedAt: CLOSED_AT });
});

test('both sides of a kept direct conversation stay keyed by the deleted account', () => {
  assert.equal(conversationPeer(kept, VIEWER, STAND_IN), GONE);
  assert.equal(conversationPeer(kept, VIEWER, VIEWER), GONE);
  const inbound = cloudMessageFromChatSync(fromStandIn, kept, VIEWER);
  assert.equal(inbound.fromAccountId, GONE);
  assert.equal(inbound.toAccountId, VIEWER);
  assert.equal(inbound.sessionId, SESSION_ID);
  const outbound = cloudMessageFromChatSync(fromViewer, kept, VIEWER);
  assert.equal(outbound.fromAccountId, VIEWER);
  assert.equal(outbound.toAccountId, GONE);
  assert.deepEqual(Object.keys(messagesByPeerFor([fromStandIn, fromViewer])), [GONE]);

  const open = directConversation({ closed: null, members: [member(VIEWER, 'active'), member(GONE, 'active')] });
  assert.equal(conversationPeer(open, VIEWER, GONE), GONE);
  assert.equal(cloudMessageFromChatSync({ ...fromStandIn, sender_account_id: GONE }, open, VIEWER).fromAccountId, GONE);
});

test('a live deletion switches the chat without a restart and keeps its session id', () => {
  const viewer = 'acct_rowan_live';
  const sessionId = `session:direct-person:${GONE}:${viewer}`;
  const snapshot = (overrides: Partial<ChatSyncConversation>) => directConversation({
    legacy_session_id: sessionId,
    preferences: { ...kept.preferences, account_id: viewer },
    ...overrides,
  });
  publishCloudDeletedDirectConversations(viewer, [snapshot({ closed: null, members: [member(viewer, 'active'), member(GONE, 'active')] })], { complete: true });
  assert.deepEqual(cloudDeletedDirectConversations(viewer), []);

  // membership.updated: the deleted account's member row is gone, the close follows.
  publishCloudDeletedDirectConversations(viewer, [snapshot({ closed: null, members: [member(viewer, 'active', 'owner'), member(STAND_IN, 'left')] })]);
  assert.deepEqual(cloudDeletedDirectConversations(viewer).map((item) => [item.sessionId, item.peerAccountId]), [[sessionId, GONE]]);
  // conversation.updated: the close by the stand-in.
  publishCloudDeletedDirectConversations(viewer, [snapshot({ members: [member(viewer, 'active', 'owner'), member(STAND_IN, 'left')] })]);
  const closed = cloudDeletedDirectConversations(viewer);
  assert.equal(closed[0]?.closedAt, CLOSED_AT);
  assert.equal(closed[0]?.sessionId, sessionId);
  // An unrelated batch leaves it, and an unchanged one keeps the same snapshot.
  publishCloudDeletedDirectConversations(viewer, [directConversation({ id: 'other', kind: 'group', legacy_session_id: 'session:group:g1' })]);
  assert.strictEqual(cloudDeletedDirectConversations(viewer), closed);
  // A complete list without it (another bootstrap) drops it.
  publishCloudDeletedDirectConversations(viewer, [], { complete: true });
  assert.deepEqual(cloudDeletedDirectConversations(viewer), []);
});

function viewerRemoved(conversationId: string, accountId = VIEWER): ChatSyncEvent {
  // The payload the server's self-serve deletion sends: no conversation snapshot.
  return {
    stream_seq: 7, event_id: `removed-${conversationId}-${accountId}`, protocol_version: 2, type: 'membership.removed',
    critical: true, conversation_id: conversationId, entity_id: conversationId, entity_version: 6,
    occurred_at: CLOSED_AT,
    payload: { conversation_id: conversationId, account_id: accountId, membership_state: 'removed', version: 6 },
  };
}

test('a chat emptied by the other person\'s own deletion never reads as kept, even with cached messages', async () => {
  // Self-serve deletion: no messages, the deleted account's row gone, the viewer removed.
  const emptied = directConversation({ closed: null, members: [member(VIEWER, 'removed', 'owner')], latest_message_sequence: 0 });
  assert.equal(deletedDirectPeerAccountId(emptied, VIEWER), null);
  assert.equal(deletedDirectPeerAccountId({ ...emptied, closed: kept.closed }, VIEWER), null, 'the viewer row decides, not the close');
  assert.equal(deletedDirectPeerAccountId(directConversation({ members: [member(STAND_IN, 'left')] }), VIEWER), null, 'no viewer row');
  assert.equal(conversationPeer(emptied, VIEWER, VIEWER), VIEWER, 'its messages are not keyed to the deleted account');

  // What reaches the device: membership.removed only. The client forgets the
  // conversation and turns it into a deleted session.
  const state = new ChatSyncState(
    async <T,>() => ({
      protocol_version: 2, events: [viewerRemoved(kept.id)], next_cursor: 'cursor-2',
      last_stream_seq: 7, has_more: false, server_time: CLOSED_AT,
    }) as T,
    () => VIEWER, () => {}, () => null, new CloudMessageDeletions(async () => []),
  );
  state.rememberConversation(directConversation({ closed: null, members: [member(VIEWER, 'active'), member(GONE, 'active')] }));
  const response = await new ChatSyncSyncClient(state).syncCloudEvents('token', 'cursor-1');
  assert.deepEqual(response.events.map((event) => [event.eventType, event.payload]), [['session.deleted', { sessionId: SESSION_ID }]]);
  assert.deepEqual(response.chat?.conversations, []);
  assert.equal(state.conversationById.has(kept.id), false);

  // Stale cached messages of that chat go with the deleted session.
  const cached = messagesByPeerFor([{ ...fromStandIn, sender_account_id: GONE }, fromViewer], directConversation({
    closed: null, members: [member(VIEWER, 'active'), member(GONE, 'active')],
  }));
  assert.deepEqual(applyCloudSyncEventsToMessagesByPeer(VIEWER, cached, response.events), {});

  // And whatever the cache still holds, nothing builds a row for it.
  const viewer = 'acct_rowan_emptied';
  publishCloudDeletedDirectConversations(viewer, [emptied], { complete: true, events: response.chat?.events });
  assert.deepEqual(cloudDeletedDirectConversations(viewer), []);
  const messageIndex = buildCloudMessageIndex(VIEWER, cached);
  assert.deepEqual(buildCloudDeletedDirectChats({
    account, entries: cloudDeletedDirectConversations(viewer), messagesByPeer: cached, messageIndex,
  }), []);
  const listed = withCloudDeletedDirectChats(
    buildCloudDesktopCollaborationState({ account, contacts: [], messagesByPeer: cached, messageIndex }),
    [],
  ).conversations.map((conversation) => conversation.id);
  assert.equal(listed.includes(cloudCollaborationConversationId(GONE, 'person')), false);
});

test('a kept chat disappears when the viewer is removed from it later', () => {
  const viewer = 'acct_rowan_later';
  const sessionId = `session:direct-person:${GONE}:${viewer}`;
  const keptHere = directConversation({
    legacy_session_id: sessionId,
    preferences: { ...kept.preferences, account_id: viewer },
    members: [member(viewer, 'active', 'owner'), member(STAND_IN, 'left')],
  });
  publishCloudDeletedDirectConversations(viewer, [keptHere], { complete: true });
  assert.equal(cloudDeletedDirectConversations(viewer).length, 1);
  // Someone else's removal changes nothing; the viewer's own removal drops it.
  publishCloudDeletedDirectConversations(viewer, [], { events: [viewerRemoved(keptHere.id, 'acct_someone_else')] });
  assert.equal(cloudDeletedDirectConversations(viewer).length, 1);
  publishCloudDeletedDirectConversations(viewer, [], { events: [viewerRemoved(keptHere.id, viewer)] });
  assert.deepEqual(cloudDeletedDirectConversations(viewer), []);
  // A snapshot showing the viewer removed drops it as well, and so does a deleted session.
  publishCloudDeletedDirectConversations(viewer, [keptHere], { complete: true });
  publishCloudDeletedDirectConversations(viewer, [{ ...keptHere, members: [member(viewer, 'removed', 'owner')] }]);
  assert.deepEqual(cloudDeletedDirectConversations(viewer), []);
  publishCloudDeletedDirectConversations(viewer, [keptHere], { complete: true });
  publishCloudDeletedDirectConversations(viewer, [], { events: [{
    ...viewerRemoved(keptHere.id), type: 'session.deleted', conversation_id: null, payload: { sessionId },
  }] });
  assert.deepEqual(cloudDeletedDirectConversations(viewer), []);

  // Until the next sync, the deleted session keeps the cached history out of the list.
  const messagesByPeer = messagesByPeerFor([fromStandIn, fromViewer]);
  assert.deepEqual(buildCloudDeletedDirectChats({
    account, entries: [entry], messagesByPeer,
    messageIndex: buildCloudMessageIndex(VIEWER, messagesByPeer), hiddenSessionIds: new Set([SESSION_ID]),
  }), []);
});

test('an open window re-renders when the close arrives', async () => {
  const viewer = 'acct_rowan_window';
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Probe() {
    const entries = useCloudDeletedDirectConversations(viewer);
    return createElement('span', null, entries.map((item) => `${item.peerAccountId}@${item.closedAt}`).join(','));
  }
  try {
    await act(async () => { root.render(createElement(Probe)); });
    assert.equal(host.textContent, '');
    await act(async () => {
      publishCloudDeletedDirectConversations(viewer, [directConversation({
        legacy_session_id: `session:direct-person:${GONE}:${viewer}`,
        preferences: { ...kept.preferences, account_id: viewer },
        members: [member(viewer, 'active', 'owner')],
      })]);
    });
    assert.equal(host.textContent, `${GONE}@${CLOSED_AT}`);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

test('the chat list keeps the conversation by recency, as Deleted account, never as a contact', () => {
  const lee = cloudContactToContact({ accountId: LEE, displayName: 'Lee Sample', avatarUrl: null, nodeId: 'node_lee', createdAt: '2026-11-01T00:00:00Z' });
  const leeMessage: CloudMessage = {
    messageId: 'lee-1', fromAccountId: LEE, toAccountId: VIEWER, body: 'Later today?',
    createdAt: '2026-11-17T09:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming',
    sessionId: `session:direct-person:${LEE}:${VIEWER}`,
  } as CloudMessage;
  const state = deletedChatState([lee], { [LEE]: [leeMessage] });
  const ids = state.conversations.map((conversation) => conversation.id);
  assert.deepEqual(ids, [cloudCollaborationConversationId(LEE, 'person'), cloudCollaborationConversationId(GONE, 'person')]);
  const chat = state.conversations[1];
  assert.equal(chat.title, 'Deleted account');
  assert.equal(chat.canonicalSessionId, SESSION_ID, 'the session id is unchanged, so local copies stay attached');
  assert.equal(chat.subtitle, 'Thanks, see you there');
  assert.deepEqual(chat.messages.map((message) => [message.direction, message.text]), [
    ['inbound', 'See you at the station'],
    ['outbound', 'Thanks, see you there'],
  ]);

  // Contacts, pickers and mention lists read the host's peers and the contact directory.
  const host = state.hosts[0];
  assert.equal(host.visiblePeers.some((peer) => peer.nodeId === GONE || peer.humanId === GONE), false);
  const directory = new Map<string, Contact>();
  addCollaborationPeerContacts(directory, host, 'Cloud');
  assert.equal([...directory.values()].some((contact) => contact.sourceParticipantId === GONE || contact.name === 'Deleted account'), false);

  // A contact entry that has not been removed yet gives way to the kept chat.
  const stale = cloudContactToContact({ accountId: GONE, displayName: 'Dana Sample', avatarUrl: null, nodeId: 'node_dana', createdAt: '2026-11-01T00:00:00Z' });
  const withStale = deletedChatState([stale]).conversations.filter((conversation) => conversation.id === chat.id);
  assert.equal(withStale.length, 1);
  assert.equal(withStale[0].title, 'Deleted account');
  // An unchanged chat keeps its object; a chat deleted here stays out.
  const messagesByPeer = messagesByPeerFor([fromStandIn]);
  const messageIndex = buildCloudMessageIndex(VIEWER, messagesByPeer);
  const built = () => buildCloudDeletedDirectChats({ account, entries: [entry], messagesByPeer, messageIndex });
  assert.strictEqual(built()[0], built()[0]);
  assert.deepEqual(buildCloudDeletedDirectChats({
    account, entries: [entry], messagesByPeer, messageIndex, hiddenSessionIds: new Set([SESSION_ID]),
  }), []);
});

test('the row shows its last message with the stand-in avatar, not as a closed group', () => {
  const view = deletedChatViewModel();
  assert.equal(isClosedConversation(view), true);
  assert.equal(isDeletedAccountConversation(view), true);
  assert.equal(view.name, 'Deleted account');
  assert.equal(view.avatarSeed, STAND_IN);
  const inbound = view.messages.find((message) => !message.isOwnMessage && message.text === 'See you at the station');
  assert.equal(inbound?.sender, 'Deleted account');
  assert.equal(inbound?.senderAvatarSeed, STAND_IN);
  assert.equal(JSON.stringify(view).includes('Dana'), false);

  const spaces = buildParticipantSpaces([view]);
  assert.equal(spaces[0]?.kind, 'direct-human');
  assert.equal(spaces[0]?.title, 'Deleted account');
  assert.equal(spaces[0]?.avatarStack[0]?.seed, `cloud-agent:${STAND_IN}`, 'one neutral avatar for every deleted account');
  assert.equal(spaces[0]?.avatarStack[0]?.imageUrl, null);
  assert.equal(isClosedParticipantSpace(spaces[0]), false);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations: [view],
    participantSpaces: spaces,
    contactParticipantSpaces: spaces,
    activeConvId: view.id,
  }) as never));
  assert.match(markup, /Deleted account/);
  assert.match(markup, /Thanks, see you there/);
  assert.doesNotMatch(markup, /data-closed=/);
  assert.doesNotMatch(markup, />Closed</);
});

test('the composer is one line saying the account was deleted', () => {
  const view = deletedChatViewModel();
  const bar = closedConversationComposer(view, { participantSpaces: buildParticipantSpaces([view]), onDeleteChatSession: async () => {} });
  assert.ok(bar);
  const markup = renderToStaticMarkup(bar);
  assert.match(markup, /data-closed-conversation-bar="true"/);
  assert.match(markup, /<span>This account was deleted\.<\/span>/);
  assert.doesNotMatch(markup, /group|channel|Delete chat/i);
  assert.equal(PEER_ACCOUNT_DELETED_LINE, 'This account was deleted.');
});

test('the Info tab loads no profile for the deleted account and keeps the plain overview', () => {
  const view = deletedChatViewModel();
  assert.equal(cloudPersonInfoPeerAccountId(view, VIEWER), null);
  assert.equal(cloudPersonInfoPeerAccountId({ ...view, metadata: undefined }, VIEWER), GONE, 'an open person chat still loads its profile');
  const slot = readFileSync(new URL('../src/app/assembleRightDetailSlot.tsx', import.meta.url), 'utf8');
  assert.match(slot, /cloudPersonInfoPeerAccountId\(args\.activeConv, account\.accountId\)/);
  assert.doesNotMatch(slot, /cloudDirectChatPeerAccountId/);
  const profiles = readFileSync(new URL('../src/pages/useChatSenderProfiles.ts', import.meta.url), 'utf8');
  assert.match(profiles, /isDeletedAccountConversation\(conversation\)\) return;/, 'the sender avatar opens no profile either');

  const markup = renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'info',
    activeConv: view,
    activeConvHasSubtitle: false,
    activeConversationUsesCollaboration: true,
    activeCollaborationAwaitingReply: false,
    isCollaborationSyncing: false,
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
  }));
  assert.match(markup, /Overview/);
  assert.match(markup, /Deleted account/);
});

test('refused writes say the account was deleted, never that a group was closed', async () => {
  const failure = terminalCollaborationSendFailure({
    error: closedResponse(), fallback: 'Unable to send message',
    conversationId: cloudCollaborationConversationId(GONE, 'person'), messageId: 'pending-1',
  });
  assert.equal(failure?.detail, 'This account was deleted.');

  const refusing = (async () => { throw closedResponse(); }) as Parameters<typeof withDeletedDirectRefusals>[0];
  const conversations = new Map([[kept.id, kept], ['group-1', directConversation({ id: 'group-1', kind: 'group', legacy_session_id: 'session:group:g1' })]]);
  const request = withDeletedDirectRefusals(refusing, (id) => conversations.get(id));
  await assert.rejects(
    request(`/v2/chat/conversations/${kept.id}/messages/m1/reactions`, { method: 'PUT' }, 'Could not add the reaction.'),
    (error: unknown) => isGroupClosedError(error) && (error as Error).message === 'This account was deleted.',
  );
  await assert.rejects(
    request('/v2/chat/conversations/group-1/messages', { method: 'POST' }, 'Could not send message.'),
    (error: unknown) => (error as Error).message === 'This group was closed.',
  );
});
