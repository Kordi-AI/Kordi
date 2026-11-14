import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCollaborationMentionTargetsByScope } from '../src/app/useKordiAppModelCollaborationMentions';
import { messageMentionsForSend } from '../src/features/chat/messageMentions';
import { parseMessageInlineParts } from '../src/kordi-app/components/messageLinks';
import type { Conversation } from '../src/kordi-app/types';

const group = {
  id: 'session:group:g',
  canonicalSessionId: 'session:group:g',
  name: 'Group',
  type: 'owned-agent',
  subtitle: '',
  unread: 0,
  collaborationSources: ['cloud'],
  trust: 'Cloud',
  directness: 'Group chat',
  participantSpaceId: 'group:g',
  participants: ['Me', 'Alice'],
  canonicalParticipants: [
    { id: 'human:acct_me', name: 'Me', kind: 'human', role: 'self', source: 'local', humanId: 'acct_me', sourceIdentityId: 'acct_me' },
    { id: 'human:acct_alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', sourceHostId: 'cloud', humanId: 'acct_alice', sourceIdentityId: 'acct_alice' },
  ],
  messages: [],
} as Conversation;

test('the group @ menu leads its agents with the built-in Facilitator', () => {
  const targets = buildCollaborationMentionTargetsByScope({
    isNativeShell: true,
    desktopCollaborationState: null,
    desktopChatState: null,
    activeConvMentionScope: group,
  });
  const facilitator = targets.chat.find((target) => target.label === 'Facilitator');
  assert.equal(facilitator?.targetKind, 'agent');
  assert.equal(facilitator?.detail, 'Built in');
  assert.equal(facilitator?.avatarImageUrl, '/kordi-system-avatar.jpg');
  assert.equal(facilitator?.agentId, null, 'never a routed cloud agent');
  assert.equal(targets.project.some((target) => target.label === 'Facilitator'), false);
});

test('@Facilitator in a group sends a mention the server answers, never an agent route', () => {
  const mentions = messageMentionsForSend('@Facilitator can you find a time? Thanks @facilitator.', group, null);
  assert.deepEqual(
    mentions.map((mention) => [mention.startUtf16, mention.displayText, mention.targetKind, mention.targetIdentityId, mention.humanId ?? null, mention.agentId ?? null]),
    [
      [0, '@Facilitator', 'agent', 'agent:cloud-agent:acct_kordi_pip', null, null],
      [41, '@facilitator', 'agent', 'agent:cloud-agent:acct_kordi_pip', null, null],
    ],
  );
  assert.deepEqual(messageMentionsForSend('@Facilitator hi', { id: 'session:direct:d' }, null), []);
  assert.deepEqual(messageMentionsForSend('@Facilitators hi', group, null), []);
  const rendered = parseMessageInlineParts('@Facilitator can you find a time?', mentions.slice(0, 1))
    .filter((part) => part.type === 'mention');
  assert.deepEqual(rendered.map((part) => part.type === 'mention' ? [part.label, part.targetKind] : []), [['@Facilitator', 'agent']]);
});
