import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  canonicalStateWithClosedSessions,
  closeSessionAfterGroupSendFailure,
  closedGroupScope,
  GROUP_CLOSED_SEND_FAILURE,
  isClosedConversation,
  isClosedParticipantSpace,
  isGroupClosedError,
  metadataWithClosedAt,
} from '../src/features/chat/closedGroup';
import { collaborationSendFailureDetail } from '../src/features/chat/messageActions/collaborationSendLifecycle';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { cloudGroupCatalogRow } from '../src/features/cloud/cloudGroupCatalog';
import { cloudGroupCatalogRowNeedsApply } from '../src/features/cloud/cloudGroupCatalogSync';
import { buildCloudAuthError } from '../src/features/cloud/cloudAuthError';
import type { CloudGroupOutboxEntry } from '../src/features/cloud/cloudGroupOutbox';
import { applyCloudGroupDeliveryRound } from '../src/features/cloud/cloudGroupOutboxRetry';
import { cloudGroupHistoryReplayPreservesSessionShell } from '../src/features/cloud/cloudGroupSessionControl';
import type { ChatSyncConversation } from '../src/features/cloud/chatSyncTypes';
import type { CanonicalSessionState } from '../src/kordi-app/types';
import { ClosedConversationBar } from '../src/pages/ClosedConversationBar';
import { GroupContextMenu } from '../src/pages/SessionActionOverlays';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import { readDesktopShellCss } from './helpers/readDesktopStyles';
import { baseSidebarProps, conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';
import { conversation as chatSyncFixture } from './helpers/chatSyncCanonicalFixtures';

const CLOSED_AT = '2026-11-13T10:00:00.000Z';
const closedResponse = () => buildCloudAuthError(409, {
  error: { code: 'group_closed', message: 'This group is closed.' },
}, 'Could not send message.');

function canonicalState(sessions: Array<{ id: string; metadata?: unknown }>): CanonicalSessionState {
  return {
    profile: { humanIdentityId: 'human:me' },
    identities: [],
    sessions: sessions.map((session) => ({
      kind: 'group',
      title: session.id,
      status: 'active',
      createdByIdentityId: 'human:me',
      createdAtMs: 1,
      updatedAtMs: 1,
      ...session,
    })),
    participants: [],
    messages: [],
  } as unknown as CanonicalSessionState;
}

test('the server closed state reads from session metadata, per session', () => {
  assert.equal(isClosedConversation({ metadata: { groupClosedAt: CLOSED_AT } }), true);
  assert.equal(isClosedConversation({ metadata: { groupClosedAt: '' } }), false);
  assert.equal(isClosedConversation({ metadata: null }), false);
  assert.deepEqual(metadataWithClosedAt({ groupClosedAt: 'earlier', kind: 'chat-group' }, CLOSED_AT), {
    groupClosedAt: 'earlier', kind: 'chat-group',
  });

  const state = canonicalState([
    { id: 'session:group:root', metadata: { groupSpaceId: 'session:group:root' } },
    { id: 'session:group:qa', metadata: { groupSpaceId: 'session:group:root' } },
  ]);
  const closedChannel = canonicalStateWithClosedSessions(state, ['session:group:qa'], CLOSED_AT);
  assert.equal(canonicalStateWithClosedSessions(closedChannel, ['session:group:qa'], 'later'), closedChannel);
  assert.deepEqual(closedGroupScope(closedChannel, 'session:group:qa'), {
    groupSpaceId: 'session:group:root',
    groupSessionIds: ['session:group:root', 'session:group:qa'],
    sessionClosed: true,
    groupClosed: false,
  });
  const closedGroup = canonicalStateWithClosedSessions(closedChannel, ['session:group:root'], CLOSED_AT);
  assert.equal(closedGroupScope(closedGroup, 'session:group:qa').groupClosed, true);
});

test('a live conversation.updated with closed re-applies its catalog row to an open session', () => {
  const group: ChatSyncConversation = {
    ...chatSyncFixture,
    kind: 'group',
    legacy_session_id: 'session:group:live',
    latest_message_sequence: 0,
  };
  const accountId = group.members[0].account_id;
  const open = cloudGroupCatalogRow(group, accountId);
  const closed = cloudGroupCatalogRow({ ...group, closed: { closed_at: CLOSED_AT, closed_by_account_id: accountId } }, accountId);
  assert.ok(open && closed, 'members are kept on close, so the row still builds');
  const has = () => true;
  assert.equal(cloudGroupCatalogRowNeedsApply(open, () => false, () => false), true);
  assert.equal(cloudGroupCatalogRowNeedsApply(open, has, () => false), false);
  assert.equal(cloudGroupCatalogRowNeedsApply(closed, has, () => false), true);
  assert.equal(cloudGroupCatalogRowNeedsApply(closed, has, () => true), false);
  // A catalog close must not be skipped by the history-replay shell shortcut.
  assert.equal(cloudGroupHistoryReplayPreservesSessionShell(true, true, true, 'group-invite'), false);

  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const replay = source('../src/features/cloud/useRecoveredCloudGroupReplay.ts');
  assert.equal((replay.match(/catalogGroupClosedAt: row\.conversation\.closed\?\.closed_at/g) ?? []).length, 2,
    'bootstrap rows and live catalog rows both carry the close');
  assert.match(replay, /isSessionClosed: sessionId => isClosedConversation\(/);
  const control = source('../src/features/cloud/cloudGroupSessionControl.ts');
  assert.match(control, /groupClosedAt: catalogGroupClosedAt\.trim\(\)/);
  assert.match(control, /delete inheritedGroupRootMetadata\.groupClosedAt;/,
    'a channel never inherits the group root close');
});

test('closed group rows stay listed, dimmed, with Closed and no unread or new-chat button', () => {
  const chatConversations = [
    conversation({
      id: 'session:group-closed',
      canonicalSessionId: 'session:group-closed',
      name: 'Infrastructure',
      subtitle: 'Bea: hi',
      unread: 3,
      metadata: { groupClosedAt: CLOSED_AT },
      messages: [{ role: 'person', sender: 'Bea', text: 'hi', time: '20:23' }],
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  assert.equal(participantSpaces[0]?.kind, 'group');
  assert.equal(isClosedParticipantSpace(participantSpaces[0]), true);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:group-closed',
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));

  assert.match(markup, /data-testid="participant-space-row"[^>]*data-closed="true"/);
  assert.match(markup, /data-testid="participant-space-session-row"[^>]*data-session-preview="Closed"[^>]*data-closed="true"/);
  assert.doesNotMatch(markup, /Bea: hi/);
  assert.doesNotMatch(markup, /data-participant-space-context-create/);
  assert.doesNotMatch(markup, /data-unread-count|app-sidebar-unread-badge/);
  assert.match(markup, /20:23|09:00/, 'the time stays');

  const openConversations = chatConversations.map((entry) => ({ ...entry, metadata: undefined }));
  const openSpaces = buildParticipantSpaces(openConversations);
  const openMarkup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations: openConversations,
    participantSpaces: openSpaces,
    contactParticipantSpaces: openSpaces,
    activeConvId: 'session:group-closed',
    initialSelectedParticipantSpaceId: openSpaces[0]?.id,
  }) as never));
  assert.match(openMarkup, /data-unread-count/, 'the same group while open shows its unread badge');
  assert.match(openMarkup, /data-participant-space-context-create/);
  assert.doesNotMatch(openMarkup, /data-closed=/);
  assert.match(readDesktopShellCss(), /\.app-session-row-closed \.app-participant-space-row-title,[\s\S]*?opacity:\s*0\.55/);
});

test('a closed group menu keeps Pin, Archive and Delete chat', (t) => {
  const globals = globalThis as { window?: unknown };
  const previousWindow = globals.window;
  globals.window = { innerWidth: 1200, innerHeight: 800 };
  t.after(() => { globals.window = previousWindow; });
  const markup = renderToStaticMarkup(createElement(GroupContextMenu, {
    target: {
      groupSpaceId: 'session:group:root', groupName: 'Infrastructure', sessionIds: ['session:group:root'],
      x: 10, y: 10, closed: true, deleteSessionId: 'session:group:root',
    },
    onClose: () => {}, onSetPinned: () => {}, onSetMuted: () => {}, onMarkRead: () => {},
    onArchive: () => {}, onRestore: () => {}, onDelete: () => {},
  }));
  assert.match(markup, /Pin group/);
  assert.match(markup, /Archive group/);
  assert.match(markup, /data-group-context-action="delete"[^>]*>.*Delete chat/);
  assert.doesNotMatch(markup, /Mark group as read|Mute group/);
});

test('the closed footer replaces the composer with one line and Delete chat', () => {
  const markup = renderToStaticMarkup(createElement(ClosedConversationBar, {
    sessionId: 'session:group:root', sessionName: 'Infrastructure', groupClosed: true,
    onDelete: async () => {},
  }));
  assert.match(markup, /data-closed-conversation-bar="true"/);
  assert.match(markup, /<span>This group was closed<\/span>/);
  assert.match(markup, /class="app-closed-conversation-delete"[^>]*>Delete chat</);
  assert.match(renderToStaticMarkup(createElement(ClosedConversationBar, {
    sessionId: 'session:group:qa', sessionName: 'QA', groupClosed: false,
  })), /This channel was closed/);

  const css = readDesktopShellCss();
  assert.match(css, /\.app-closed-conversation-bar\s*{[^}]*gap:\s*14px;[^}]*height:\s*46px;[^}]*border-radius:\s*14px;[^}]*color-mix\(in oklab, var\(--app-sidebar-selected-bg\) 55%, transparent\)[^}]*font-size:\s*12\.5px/s);
  assert.match(css, /\.app-closed-conversation-delete\s*{[^}]*color:\s*var\(--app-danger-text\)/s);
  assert.match(css, /\.app-closed-conversation-delete:focus-visible\s*{[^}]*outline:\s*none;/s, 'neutral focus, no ring');

  const workspace = readFileSync(new URL('../src/pages/chatsPage.mainWorkspace.tsx', import.meta.url), 'utf8');
  assert.match(workspace, /composer: isEmptySelection \? null : activeClosed \? \(\s*<ClosedConversationBar/);
});

test('a group_closed send failure stops retrying, says the group was closed, and marks it closed', () => {
  const error = closedResponse();
  assert.equal(isGroupClosedError(error), true);
  assert.equal(isGroupClosedError(new Error('boom')), false);
  assert.equal(collaborationSendFailureDetail(error, 'Unable to send group message'), GROUP_CLOSED_SEND_FAILURE);

  const entry: CloudGroupOutboxEntry = {
    canonicalMessageId: 'message-1', sessionId: 'session:group:root', envelope: '{}',
    pendingRecipientIds: ['acct_b'], deliveredRecipientIds: [], attemptsByRecipientId: {}, nextAttemptAtMs: 0,
  };
  applyCloudGroupDeliveryRound(entry, ['acct_b'], [{ status: 'rejected', reason: error }], 1_000);
  assert.deepEqual(entry.pendingRecipientIds, []);
  assert.deepEqual(entry.exhaustedRecipientIds, ['acct_b'], 'one refusal is enough');

  let state: CanonicalSessionState | null = canonicalState([{ id: 'session:group:root' }]);
  const setState = (update: (current: CanonicalSessionState | null) => CanonicalSessionState | null) => {
    state = update(state);
  };
  closeSessionAfterGroupSendFailure(new Error('offline'), 'session:group:root', setState);
  assert.equal(isClosedConversation(state?.sessions[0]), false);
  closeSessionAfterGroupSendFailure(error, 'session:group:root', setState);
  assert.equal(isClosedConversation(state?.sessions[0]), true);
});

test('closing keeps the group for the closer, and Delete chat on a closed group leaves it', () => {
  const source = readFileSync(new URL('../src/app/useKordiChatSessionActions.ts', import.meta.url), 'utf8');
  const dissolve = source.slice(source.indexOf('const dissolveGroup'), source.indexOf('return {', source.indexOf('const dissolveGroup')));
  assert.match(dissolve, /await markSessionsClosed\(sessionIds\);/);
  assert.match(dissolve, /await markSessionsClosed\(\[sessionId\]\);/);
  assert.doesNotMatch(dissolve, /dropSessionsLocally|optimisticallyRemoveSession|deleteDesktopChatSessionForever/);
  assert.match(source, /if \(closedScope\.groupClosed\) \{[\s\S]*?leaveGroup\(login\.token, closedScope\.groupSpaceId\);[\s\S]*?dropSessionsLocally\(closedScope\.groupSessionIds\);/);
});
