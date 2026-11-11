import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidElement, type ReactElement } from 'react';

import { MessageSeenByProvider } from '../src/features/chat/MessageSeenByProvider';
import type { Conversation, ConversationParticipant, Message } from '../src/kordi-app/types';
import { ChatThreadPanel } from '../src/pages/ChatThreadPanel';
import { chatDiscussionPane, type ChatDiscussionPaneInput } from '../src/pages/chatsPage.discussionPane';
import { conversationIsGroupChat } from '../src/pages/chatsPage.model';

// Synthetic group and people only.
const participants: ConversationParticipant[] = [
  { id: 'human:acct_me', name: 'Me', kind: 'human', role: 'self' },
  { id: 'human:acct_maya', name: 'Maya Patel', kind: 'human', role: 'person' },
];
const root: Message = { id: 'msg:root', role: 'user', sender: 'Me', senderType: 'human', isOwnMessage: true, text: 'Plan for Thursday', time: '10:40' };

function pane(activeConv: Partial<Conversation>) {
  const input = {
    activeConv, activeSessionId: activeConv.canonicalSessionId, activeThread: { root, replies: [] }, activeThreadRootId: root.id,
    activeLiveTurnThreadRootId: null, activeThreadQueuedMessages: [], activePaneKind: 'human',
    unreadThreads: { page: null }, threadReadStatus: { reads: null }, routing: {}, pins: {}, runtime: {}, composer: {}, transcript: {},
    isNativeShell: true,
  } as unknown as ChatDiscussionPaneInput;
  return chatDiscussionPane(input) as ReactElement<{ isGroup: boolean; participants: unknown; children: ReactElement }>;
}

// The discussion panel is outside the main transcript's provider, so it mounts its own.
test('a group discussion offers the Seen row with the same inputs as the main transcript', () => {
  const group = { id: 'group-conversation', canonicalSessionId: 'session:group:launch', directness: 'group', canonicalParticipants: participants, participants: ['Maya Patel'], messages: [] } as Partial<Conversation>;
  const element = pane(group);
  assert.equal(element.type, MessageSeenByProvider);
  assert.equal(element.props.isGroup, conversationIsGroupChat(group as Conversation));
  assert.equal(element.props.isGroup, true);
  assert.equal(element.props.participants, participants);
  assert.ok(isValidElement(element.props.children) && element.props.children.type === ChatThreadPanel);
});

test('a direct discussion keeps the row off', () => {
  const direct = { id: 'direct-conversation', canonicalSessionId: 'session:direct-person:acct_me:acct_maya', directness: 'direct', canonicalParticipants: participants, participants: ['Maya Patel'], messages: [] } as Partial<Conversation>;
  assert.equal(pane(direct).props.isGroup, false);
});
