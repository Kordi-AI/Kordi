import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  resolveLeadingAgentMentionTarget,
  resolvePreferredAgentMentionTarget,
  selectedComposerAgentMentionTarget,
} from '../src/features/chat/messageActions/cloudAgentMentionTarget';
import { messageMentionsForSend } from '../src/features/chat/messageMentions';
import { promptTextForCloudAgentMention } from '../src/features/cloud/cloudAgentMessages';
import type { ComposerMentionOption } from '../src/kordi-app/components';
import type { DesktopChatState, DesktopCollaborationState } from '../src/kordi-app/types';

// Synthetic accounts: the sender leads with their own agent and names a partner agent.
const collaborationState = {
  activeHostId: 'cloud',
  hosts: [{
    id: 'cloud', endpoint: 'cloud', nodeId: 'acct_lead', humanId: 'acct_lead', ownerName: 'Lead Owner',
    activeAgentId: 'agent-lead', agents: [{ id: 'agent-lead', label: 'Kordi', nodeId: 'acct_lead', runtime: 'kordi-local', isDefault: true }],
    visiblePeers: [{
      endpoint: 'cloud', nodeId: 'acct_partner', displayName: 'Kordi', ownerName: 'Partner', runtime: 'kordi-cloud-agent',
      humanId: 'acct_partner', agentId: 'cloud-agent:acct_partner', isDefaultAgent: true, isContact: true,
      contactRequestStatus: 'approved', sharedProjects: [],
    }],
  }],
} as unknown as DesktopCollaborationState;
const chatState = { localAgent: { label: 'Kordi' } } as DesktopChatState;
const directPerson = {
  id: 'bridge:cloud:acct_partner:person', canonicalSessionId: 'session:direct-person:acct_lead:acct_partner',
  directness: 'Direct person chat', collaborationTarget: { hostId: 'cloud', nodeId: 'acct_partner', humanId: 'acct_partner', runtime: 'person' },
  canonicalParticipants: [{ id: 'human:acct_partner', name: 'Partner', kind: 'human', role: 'person', humanId: 'acct_partner', sourceIdentityId: 'acct_partner' }],
};
const group = { ...directPerson, id: 'group-1', canonicalSessionId: 'session:group:discussion', directness: 'Group chat', participantSpaceId: 'group-space' };
const discussion = '@KordiLeadOwner discuss with @KordiPartner which is better for a weekend trip: beach or mountains. Then summarize.';
const partnerOption = {
  value: 'KordiPartner', label: 'Kordi', targetKind: 'agent', sourceHostId: 'cloud', nodeId: 'acct_partner',
  humanId: 'acct_partner', agentId: 'cloud-agent:acct_partner', ownerName: 'Partner', runtime: 'kordi-cloud-agent',
} satisfies ComposerMentionOption;

for (const [name, conversation] of [['direct chat', directPerson], ['group', group]] as const) {
  test(`the first-mentioned own agent leads a discussion in a ${name}`, async () => {
    const lead = await resolvePreferredAgentMentionTarget(discussion, chatState, collaborationState, conversation, [], undefined, false, true);
    assert.equal(lead?.peer.humanId, 'acct_lead');
    assert.equal(lead?.peer.agentId, 'cloud-agent:acct_lead');
    assert.equal(lead?.requestText.startsWith('discuss with @KordiPartner'), true);

    // The partner picked last in the composer must not take over the lead.
    const selected = selectedComposerAgentMentionTarget(discussion, partnerOption, collaborationState);
    const resolved = await resolveLeadingAgentMentionTarget(discussion, selected, () => (
      resolvePreferredAgentMentionTarget(discussion, chatState, collaborationState, conversation, [], undefined, false, true)
    ));
    assert.equal(resolved?.peer.humanId, 'acct_lead');

    const agentMentions = messageMentionsForSend(discussion, conversation, resolved).filter((mention) => mention.targetKind === 'agent');
    assert.deepEqual(agentMentions.map((mention) => [mention.displayText, mention.agentId]), [['@KordiLeadOwner', 'cloud-agent:acct_lead']]);
  });
}

test('a partner agent mentioned first still leads', async () => {
  const text = '@KordiPartner discuss with @KordiLeadOwner which is better';
  const lead = await resolvePreferredAgentMentionTarget(text, chatState, collaborationState, directPerson, [], undefined, false, true);
  assert.equal(lead?.peer.humanId, 'acct_partner');
  const selected = selectedComposerAgentMentionTarget(text, partnerOption, collaborationState);
  let resolverCalls = 0;
  const resolved = await resolveLeadingAgentMentionTarget(text, selected, async () => { resolverCalls += 1; return null; });
  assert.equal(resolved?.peer.humanId, 'acct_partner');
  assert.equal(resolverCalls, 0, 'a selected agent that is the first mention needs no further resolution');
});

test('an agent prompt keeps a partner mention after the leading address', () => {
  assert.equal(promptTextForCloudAgentMention(discussion), discussion.replace('@KordiLeadOwner ', ''));
  assert.equal(promptTextForCloudAgentMention('@KordiLeadOwner'), '@KordiLeadOwner');
});
