import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { CloudCallContext } from '../src/features/cloud/cloudCallContextValue';
import type { CloudCallsController } from '../src/features/cloud/cloudCallController';
import { cloudCallTargetForConversation } from '../src/features/cloud/cloudCalls';
import { HUMAN_CANONICAL_AVATAR_STYLE, generatedAvatarPreviewUrl } from '../src/features/cloud/canonicalAvatar';
import { isDeletedAccountSender } from '../src/features/systemAgent/systemAgentIdentity';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { CanonicalIdentity, CanonicalSessionMessage, Conversation, Message } from '../src/kordi-app/types';
import { chatHeaderSubtitle } from '../src/pages/chatsPage.header';
import { MainChatHeader } from '../src/pages/chatsPage.mainHeader';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';
import { GONE, keptChatViewModel, STAND_IN, VIEWER, viewerAccount } from './helpers/deletedAccountChatFixtures';
import { baseSidebarProps } from './helpers/workspaceSidebarParticipantSpacesFixtures';

const standInAvatarUrl = generatedAvatarPreviewUrl(HUMAN_CANONICAL_AVATAR_STYLE, STAND_IN);
const openProfile = () => {};

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

test('the chat list row draws the stand-in avatar, the same one the transcript shows', () => {
  assert.ok(standInAvatarUrl);
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
  assert.ok(sidebar.includes(standInAvatarUrl), 'the row loads the generated stand-in avatar');
  assert.doesNotMatch(sidebar, /data-avatar-state="fallback"/);
  // The deleted id still keys the row, but never draws it.
  assert.doesNotMatch(sidebar, new RegExp(`/avatars/[^"]*(?:${GONE}|cloud-agent)`));

  const bubble = renderToStaticMarkup(createElement(MessageBubble, { msg: inboundMessage(view) }));
  assert.ok(bubble.includes(standInAvatarUrl));
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
  assert.match(groupMarkup, /Deleted account avatar/);
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
