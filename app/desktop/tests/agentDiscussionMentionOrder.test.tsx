import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { buildCollaborationMentionTargetsByScope } from '../src/app/useKordiAppModelCollaborationMentions';
import {
  cloudAgentMentionIdentity,
  resolveLeadingAgentMentionTarget,
  resolvePreferredAgentMentionTarget,
  selectedComposerAgentMentionTarget,
} from '../src/features/chat/messageActions/cloudAgentMentionTarget';
import { resolveDirectHostedAgentTarget } from '../src/features/chat/messageActions/directHostedAgentTarget';
import { messageMentionsForSend } from '../src/features/chat/messageMentions';
import { promptTextForCloudAgentMention } from '../src/features/cloud/cloudAgentMessages';
import { buildCloudCollaborationHost } from '../src/features/cloud/cloudCollaborationState';
import { cloudGroupHumanAgentTarget } from '../src/features/cloud/cloudGroupAgentTarget';
import type { CloudAccount } from '../src/features/cloud/authClient';
import type { Contact, DesktopChatState, DesktopCollaborationState } from '../src/kordi-app/types';
import { cloudAccountAvatarFixture as avatar } from './helpers/cloudAccountAvatarFixture';

// The sender's view, built with the same Cloud host and composer option code as
// the app. Synthetic accounts: the sender, a DM peer, and a third group member.
const contact = (accountId: string, name: string) => ({
  id: `cloud:${accountId}`, name, initials: name.slice(0, 2), sourceHostId: 'cloud', sourceParticipantId: accountId,
  contactStatus: 'accepted', owner: name, targetCloudAgentId: `cloud-agent:${accountId}`, targetCloudAgentName: 'Kordi',
}) as unknown as Contact;
const account = { accountId: 'acct_sender', displayName: 'Sender', primaryEmail: 'sender@example.test', nodeId: 'node_sender', avatar, defaultAgent: null } as unknown as CloudAccount;
const state = {
  activeHostId: 'cloud', conversations: [],
  hosts: [buildCloudCollaborationHost(account, [contact('acct_peer', 'Peer'), contact('acct_third', 'Third')])],
} as unknown as DesktopCollaborationState;
const chat = { localAgent: { label: 'Kordi' } } as DesktopChatState;
const human = (accountId: string, name: string, role = 'person') => ({ id: `human:${accountId}`, name, kind: 'human', role, humanId: accountId, sourceIdentityId: accountId });
const directChat = {
  id: 'bridge:cloud:acct_peer:person', canonicalSessionId: 'session:direct-person:acct_peer:acct_sender', directness: 'Direct person chat',
  collaborationTarget: { hostId: 'cloud', nodeId: 'acct_peer', humanId: 'acct_peer', runtime: 'person' },
  canonicalParticipants: [human('acct_peer', 'Peer'), human('acct_sender', 'Sender', 'self')],
};
const groupChat = {
  id: 'group-1', canonicalSessionId: 'session:group:plans', directness: 'Group chat', participantSpaceId: 'group-space',
  canonicalParticipants: [human('acct_peer', 'Peer'), human('acct_third', 'Third'), human('acct_sender', 'Sender', 'self')],
};
const participants = ['acct_sender', 'acct_peer', 'acct_third'].map((accountId) => ({ accountId, displayName: accountId, avatarUrl: null }));

async function send(text: string, conversation: typeof directChat | typeof groupChat, pickedLast: string | null) {
  const options = buildCollaborationMentionTargetsByScope({
    isNativeShell: true, desktopCollaborationState: state, desktopChatState: chat, activeConvMentionScope: conversation,
  }).chat;
  const picked = options.find((option) => option.value === pickedLast) ?? null;
  if (pickedLast) assert.ok(picked, `composer offers @${pickedLast}`);
  const target = await resolveLeadingAgentMentionTarget(text, selectedComposerAgentMentionTarget(text, picked, state), () => (
    resolvePreferredAgentMentionTarget(text, chat, state, conversation, [], undefined, false, true)
  ));
  const identity = cloudAgentMentionIdentity(target);
  const mentions = messageMentionsForSend(text, conversation, target);
  const direct = resolveDirectHostedAgentTarget({ mentionedAgentId: identity.targetCloudAgentId, mentionedTarget: target, activeTarget: null });
  return { identity, mentions, direct };
}

const cases = [
  { name: 'own agent first, peer agent second', text: '@KordiSender discuss with @KordiPeer which is better', lead: 'acct_sender' },
  { name: 'peer agent first, own agent second', text: '@KordiPeer find a time for a 1-hour coffee chat with @KordiSender this weekend', lead: 'acct_peer' },
  { name: 'peer agent first, third agent second', text: '@KordiPeer plan dinner with @KordiThird on Friday', lead: 'acct_peer', groupOnly: true },
];

for (const [label, conversation] of [['direct chat', directChat], ['group', groupChat]] as const) {
  for (const { name, text, lead, groupOnly } of cases) {
    if (groupOnly && conversation === directChat) continue;
    test(`${label}: ${name} sends an agent request for the first agent`, async () => {
      const leadHandle = text.slice(1, text.indexOf(' '));
      const partnerHandle = /with @(\w+)/u.exec(text)![1];
      for (const pickedLast of [null, leadHandle, partnerHandle]) {
        const { identity, mentions, direct } = await send(text, conversation, pickedLast);
        assert.equal(identity.targetCloudAgentId, `cloud-agent:${lead}`, `picked last: ${pickedLast}`);
        assert.equal(identity.ownerAccountId, lead);
        assert.deepEqual(mentions.filter((mention) => mention.targetKind === 'agent').map((mention) => mention.displayText), [`@${leadHandle}`]);
        assert.equal(direct?.targetCloudAgentOwnerAccountId, lead, 'a direct chat send carries the agent target');
        if (conversation === groupChat) {
          const target = cloudGroupHumanAgentTarget({
            id: 'm1', senderAccountId: 'acct_sender', text, createdAtMs: 1, mentions,
            targetCloudAgentId: identity.targetCloudAgentId, targetCloudAgentOwnerAccountId: identity.ownerAccountId,
          }, participants);
          assert.equal(target?.ownerAccountId, lead, 'the group runs the leading agent');
        }
      }
      assert.ok(promptTextForCloudAgentMention(text).includes(`@${partnerHandle}`), 'the partner stays in the request');
    });
  }
}

test('a retried message keeps its agent target and mentions', () => {
  const source = readFileSync(new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url), 'utf8');
  const retry = source.slice(source.indexOf('if (retryMessage) {'), source.indexOf('if (activeConversationUsesCollaborationRouting) { setDesktopChatError(\'Retry is unavailable'));
  assert.match(retry, /kind: 'group-message',[\s\S]*?mentions: messageMentions,[\s\S]*?targetCloudAgentId,/);
  assert.match(retry, /resolveDirectHostedAgentTarget\(\{\s*mentionedAgentId: targetCloudAgentId,\s*mentionedTarget,/);
  assert.match(retry, /const retryCloudBody = retryDirectHostedAgentTarget \|\| messageMentions\.length[\s\S]*?mentions: messageMentions,/);
});
