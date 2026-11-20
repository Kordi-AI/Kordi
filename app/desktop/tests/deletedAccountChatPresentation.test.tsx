import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { CloudCallContext } from '../src/features/cloud/cloudCallContextValue';
import type { CloudCallsController } from '../src/features/cloud/cloudCallController';
import { cloudCallTargetForConversation } from '../src/features/cloud/cloudCalls';
import { AGENT_CANONICAL_AVATAR_STYLE, HUMAN_CANONICAL_AVATAR_STYLE, generatedAvatarPreviewUrl } from '../src/features/cloud/canonicalAvatar';
import { isDeletedAccountSender } from '../src/features/systemAgent/systemAgentIdentity';
import { GroupAvatar } from '../src/kordi-app/components/GroupAvatar';
import { IdentityAvatar } from '../src/kordi-app/components/IdentityAvatar';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import { ChatDetailPanel } from '../src/pages/ChatDetailPanel';
import type { CanonicalIdentity, CanonicalSessionMessage, Conversation, Message } from '../src/kordi-app/types';
import { chatHeaderSubtitle } from '../src/pages/chatsPage.header';
import { MainChatHeader } from '../src/pages/chatsPage.mainHeader';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import { GONE, keptChatViewModel, STAND_IN, VIEWER, viewerAccount } from './helpers/deletedAccountChatFixtures';
import { baseSidebarProps } from './helpers/workspaceSidebarParticipantSpacesFixtures';

const openProfile = () => {};

/** The neutral placeholder: a flat muted square with nothing inside, named "Deleted account", and no picture or request. */
function assertStandInPlaceholder(markup: string) {
  assert.match(markup, /role="img" aria-label="Deleted account"[^>]*data-avatar-state="placeholder"/);
  assert.match(markup, /data-avatar-state="placeholder"[^>]*><span class="block h-full w-full bg-slate-200 dark:bg-slate-700" aria-hidden="true"><\/span><\/div>/);
  // The square holds only that empty span: no glyph or icon.
  assert.doesNotMatch(markup, /lucide-/, 'no glyph inside the square');
  assert.doesNotMatch(markup, new RegExp(`/avatars/[^"]*${STAND_IN}`), 'no avatar URL is built for the stand-in');
  assert.doesNotMatch(markup, /<img/);
}

function inboundMessage(view: Conversation): Message {
  const message = view.messages.find((candidate) => !candidate.isOwnMessage && candidate.text === 'See you at the station');
  assert.ok(message);
  return message;
}

function header(conversation: Conversation, subtitle: string | null) {
  const noop = () => {};
  const calls = {
    currentCall: null,
    targetForConversation: (candidate: Conversation) => cloudCallTargetForConversation(viewerAccount, candidate),
    callForConversation: () => null,
  } as unknown as CloudCallsController;
  return renderToStaticMarkup(createElement(CloudCallContext.Provider, { value: calls }, createElement(MainChatHeader, {
    conversation,
    layout: { showSessionToggle: false, sessionsCollapsed: false, onToggleSessions: noop, showDestinations: false, destination: 'messages', onSelectDestination: noop },
    metadata: { subtitle, forkSourceSessionId: null, forkSourceTitle: '' },
    rename: { enabled: false, editing: false, draft: '', sessionId: conversation.id, setDraft: noop, begin: noop, cancel: noop, commit: noop },
    companion: { view: 'chat', isOpen: false, canOpenChat: true, hasChat: true, onSelect: noop, onHide: noop },
  })));
}

test('the chat list row and the transcript draw the stand-in as the neutral placeholder', () => {
  const view = keptChatViewModel();
  const [space] = buildParticipantSpaces([view]);
  assert.equal(space?.kind, 'direct-human');
  const avatar = space?.avatarStack[0];
  // A seed the avatar service refuses (such as "cloud-agent:...") left the row a blank square.
  assert.deepEqual([avatar?.kind, avatar?.seed, avatar?.imageUrl, avatar?.isSelf], ['human', STAND_IN, null, undefined]);
  assert.equal(inboundMessage(view).senderAvatarSeed, avatar?.seed);

  const sidebar = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations: [view], participantSpaces: [space], contactParticipantSpaces: [space], activeConvId: view.id,
  }) as never));
  const row = sidebar.slice(sidebar.indexOf('data-testid="participant-space-row"'));
  assertStandInPlaceholder(row.slice(0, row.indexOf('</button>')));
  // The deleted id still keys the row, but never draws it.
  assert.doesNotMatch(sidebar, new RegExp(`/avatars/[^"]*(?:${GONE}|${STAND_IN}|cloud-agent)`));

  assertStandInPlaceholder(renderToStaticMarkup(createElement(MessageBubble, { msg: inboundMessage(view) })));
});

test('the Info tab, group tiles and every stand-in seed draw the placeholder, while people keep their avatars', () => {
  const view = keptChatViewModel();
  const info = renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true, activeDetailTab: 'info', activeConv: view, activeConvHasSubtitle: false,
    activeConversationUsesCollaboration: true, activeCollaborationAwaitingReply: false, isCollaborationSyncing: false,
    artifacts: [], activeArtifactId: null, onSelectArtifact: () => {},
  }));
  assertStandInPlaceholder(info.slice(info.indexOf('aria-label="Deleted account"') - 400));

  // A picture the server still lists for the stand-in, and the agent it does not have, are ignored too.
  for (const [kind, seed] of [['human', STAND_IN], ['human', `human:${STAND_IN}`], ['agent', `cloud-agent:${STAND_IN}`]] as const) {
    assertStandInPlaceholder(renderToStaticMarkup(createElement(IdentityAvatar, {
      kind, seed, name: 'Deleted account', imageUrl: `kordi-avatar://dicebear-rust-10.6.0-styles-10.5.0/lorelei/${STAND_IN}?version=1`,
    })));
  }

  const leeUrl = generatedAvatarPreviewUrl(HUMAN_CANONICAL_AVATAR_STYLE, 'acct_lee');
  const viewerUrl = generatedAvatarPreviewUrl(HUMAN_CANONICAL_AVATAR_STYLE, viewerAccount.avatar.seed);
  assert.ok(leeUrl && viewerUrl);
  const tile = renderToStaticMarkup(createElement(GroupAvatar, {
    name: 'Weekend',
    avatars: [
      { kind: 'human', seed: 'acct_lee', imageUrl: null },
      { kind: 'human', seed: viewerAccount.avatar.seed, isSelf: true, imageUrl: null },
      { kind: 'human', seed: STAND_IN, imageUrl: null },
    ],
  }));
  assert.ok(tile.includes(leeUrl), 'a person keeps their generated avatar');
  assert.ok(tile.includes(viewerUrl), 'so does the viewer');
  assert.match(tile, /data-avatar-state="placeholder"/);
  assert.doesNotMatch(tile, new RegExp(`/avatars/[^"]*${STAND_IN}`));
  const viewer = renderToStaticMarkup(createElement(IdentityAvatar, { kind: 'human', seed: viewerAccount.avatar.seed, isSelf: true, name: 'Rowan Sample' }));
  assert.ok(viewer.includes(viewerUrl));
  assert.doesNotMatch(viewer, /placeholder|aria-label="Deleted account"/);
  const agent = renderToStaticMarkup(createElement(IdentityAvatar, { kind: 'agent', seed: 'cloud-agent:acct_lee', name: "Lee's Kordi" }));
  assert.ok(agent.includes(generatedAvatarPreviewUrl(AGENT_CANONICAL_AVATAR_STYLE, 'default-agent-acct_lee') ?? 'missing'));
});

test('the stand-in never draws from the viewer, nor from the deleted account', () => {
  const view = keptChatViewModel();
  const seeds = [
    view.avatarSeed,
    ...Object.entries(view.participantAvatarSeeds ?? {}).filter(([name]) => name === 'Deleted account').map(([, seed]) => seed),
    ...view.messages.filter((message) => !message.isOwnMessage).map((message) => message.senderAvatarSeed),
  ];
  assert.ok(seeds.length >= 3);
  for (const seed of seeds) assert.equal(seed, STAND_IN);
  assert.notEqual(viewerAccount.avatar.seed, STAND_IN);
  assert.equal(seeds.includes(VIEWER) || seeds.includes(GONE), false);
  const bubble = renderToStaticMarkup(createElement(MessageBubble, { msg: inboundMessage(view) }));
  assert.doesNotMatch(bubble, new RegExp(VIEWER));
});

test('the header of a kept chat shows no presence line and no call buttons', () => {
  const view = keptChatViewModel();
  assert.equal(cloudCallTargetForConversation(viewerAccount, view), null, 'no call and no presence lookup for the deleted id');
  assert.equal(chatHeaderSubtitle(view, 'last seen recently'), null);
  assert.equal(chatHeaderSubtitle(view), null, 'nor the last message in its place');
  const markup = header(view, chatHeaderSubtitle(view, 'last seen recently'));
  assert.match(markup, /Deleted account/);
  assert.doesNotMatch(markup, /last seen|online|data-chat-session-subtitle/);
  assert.doesNotMatch(markup, /Start voice call|Start video call|Call actions/);

  // An open person chat keeps both.
  const open = { ...view, metadata: undefined };
  assert.equal(cloudCallTargetForConversation(viewerAccount, open)?.peerAccountId, GONE);
  assert.equal(chatHeaderSubtitle(open, 'last seen recently'), 'last seen recently');
  const openMarkup = header(open, chatHeaderSubtitle(open, 'last seen recently'));
  assert.match(openMarkup, /last seen recently/);
  assert.match(openMarkup, /Start voice call/);
  assert.match(openMarkup, /Start video call/);
});

function groupMessage(senderIdentityId: string): CanonicalSessionMessage {
  return {
    id: `group-message:${senderIdentityId}`, sessionId: 'session:group:crew', senderIdentityId, senderRole: 'person',
    messageKind: 'text', contentText: 'Moved to Friday', content: { schema: 1, blocks: [{ type: 'text', text: 'Moved to Friday' }] },
    status: 'received', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, sourceTransport: 'cloud-group',
  } as CanonicalSessionMessage;
}

function cloudIdentity(accountId: string, displayName: string): CanonicalIdentity {
  return {
    id: `human:${accountId}`, kind: 'human', displayName, source: 'cloud', sourceHostId: 'cloud',
    sourceIdentityId: accountId, humanId: accountId, avatarKey: accountId, createdAtMs: 1, updatedAtMs: 1,
    // A picture the server may still list next to an account; the stand-in never shows one.
    profileImageUrl: `kordi-avatar://dicebear-rust-10.6.0-styles-10.5.0/lorelei/${accountId}?version=1`,
  };
}

function assertInertAvatar(markup: string) {
  assert.doesNotMatch(markup, /<button[^>]*data-message-sender-profile/);
  assert.doesNotMatch(markup, /data-message-sender-profile/);
  assert.doesNotMatch(markup, /aria-label="[^"]*profile[^"]*"/i);
  assert.doesNotMatch(markup, /tabindex=/i);
}

test('a Deleted account sender avatar is not a button, in a direct chat or a group', () => {
  const direct = inboundMessage(keptChatViewModel());
  assert.equal(isDeletedAccountSender(direct), true);
  assertInertAvatar(renderToStaticMarkup(createElement(MessageBubble, { msg: direct, onOpenSenderProfile: openProfile })));

  const standIn = cloudIdentity(STAND_IN, 'Deleted account');
  const lee = cloudIdentity('acct_lee', 'Lee Sample');
  const identities = new Map([[standIn.id, standIn], [lee.id, lee]]);
  const fromStandIn = mapCanonicalMessage(groupMessage(standIn.id), identities, `human:${VIEWER}`);
  assert.ok(fromStandIn);
  assert.equal(isDeletedAccountSender(fromStandIn), true);
  const groupMarkup = renderToStaticMarkup(createElement(MessageBubble, { msg: fromStandIn, onOpenSenderProfile: openProfile }));
  assertStandInPlaceholder(groupMarkup);
  assertInertAvatar(groupMarkup);

  // Anyone else's avatar still opens their profile.
  const fromLee = mapCanonicalMessage(groupMessage(lee.id), identities, `human:${VIEWER}`);
  assert.ok(fromLee);
  assert.equal(isDeletedAccountSender(fromLee), false);
  assert.match(
    renderToStaticMarkup(createElement(MessageBubble, { msg: fromLee, onOpenSenderProfile: openProfile })),
    /<button[^>]*data-message-sender-profile="true"[^>]*aria-label="Open Lee Sample profile"/,
  );
});
