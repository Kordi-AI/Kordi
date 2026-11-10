import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCollaborationMentionCandidates,
  filterCollaborationMentionCandidatesForConversation,
  resolveMentionedCollaborationTarget,
  uniqueAgentMentionCandidates,
  type SharedCloudAgentMentionCandidate,
} from '../src/features/chat/messageActions/mentions';
import { selectedComposerAgentMentionTarget, typedAgentMentionIsAmbiguous } from '../src/features/chat/messageActions/cloudAgentMentionTarget';
import type { ComposerMentionOption } from '../src/kordi-app/components';
import type { Conversation, DesktopCollaborationPeer, DesktopCollaborationState } from '../src/kordi-app/types';

// Two people named alike ("Shu Yang" and "shu yang") and the viewer's own
// agent named like theirs: every agent handle must still be unique.
const agentPeer = (humanId: string, ownerName: string): DesktopCollaborationPeer => ({
  nodeId: humanId, humanId, agentId: `cloud-agent:${humanId}`, runtime: 'kordi-cloud-agent', displayName: 'Kordi',
  ownerName, isDefaultAgent: true, endpoint: `https://${humanId}.example`, sharedProjects: [], isContact: true,
  contactRequestStatus: 'approved',
} as DesktopCollaborationPeer);

const state = (peers: DesktopCollaborationPeer[]): DesktopCollaborationState => ({
  conversations: [], activeHostId: 'host', hosts: [{
    id: 'host', registered: true, connected: true, serverUrl: 'http://127.0.0.1:1', displayName: 'Viewer', ownerName: 'shu yang',
    endpoint: 'https://host.example', tokenPresent: true, humanId: 'acctviewer', discoveryMode: 'manual', nodeId: 'acctviewer',
    activeAgentId: 'local', agents: [], visiblePeers: peers, visiblePeerCount: peers.length, projects: [],
  }],
} as unknown as DesktopCollaborationState);

const group = {
  id: 'session:group:dup', canonicalSessionId: 'session:group:dup', name: 'Group', type: 'owned-agent', subtitle: '', unread: 0,
  collaborationSources: ['Cloud'], trust: 'Cloud', directness: 'Group chat', participants: ['shu yang', 'Shu Yang', 'Sam'],
  participantSpaceId: 'group:dup', messages: [],
  canonicalParticipants: [
    { id: 'human:acctviewer', name: 'shu yang', kind: 'human', role: 'self', source: 'cloud', humanId: 'acctviewer', sourceIdentityId: 'acctviewer' },
    { id: 'human:acctother', name: 'Shu Yang', kind: 'human', role: 'person', source: 'cloud', humanId: 'acctother', sourceIdentityId: 'acctother' },
    { id: 'human:acctsam', name: 'Sam', kind: 'human', role: 'person', source: 'cloud', humanId: 'acctsam', sourceIdentityId: 'acctsam' },
  ],
} as unknown as Conversation;

test("another agent named like the viewer's own gets its own handle, and a typed handle never picks it", () => {
  const collaboration = state([agentPeer('acctother', 'Shu Yang')]);
  const own = 'Kordishuyang';
  const plain = buildCollaborationMentionCandidates(collaboration).find((c) => c.targetKind === 'agent')!;
  assert.equal(plain.handle.toLowerCase(), own.toLowerCase(), 'the same base handle as the viewer\'s own agent');
  const unique = uniqueAgentMentionCandidates([plain], [], [own]).collaboration[0];
  assert.notEqual(unique.normalizedHandle, own.toLowerCase());
  assert.ok(unique.handle.toLowerCase().startsWith(own.toLowerCase()));

  const typed = resolveMentionedCollaborationTarget(`@${own} hi`, collaboration, group, { targetKind: 'agent', reservedHandles: [own] });
  assert.equal(typed, null, "the viewer's own agent keeps the plain handle");
  const picked = resolveMentionedCollaborationTarget(`@${unique.handle} hi`, collaboration, group, { targetKind: 'agent', reservedHandles: [own] });
  assert.equal(picked?.peer.humanId, 'acctother', 'the suffixed handle names the other agent by its owner');
});

test('two shared agents with one name get distinct handles from their owners', () => {
  const shared = (owner: string) => ({
    agent: { agentId: `cloud_agent_${owner}`, ownerAccountId: owner, name: 'Planner' }, handle: 'Planner', normalizedHandle: 'planner',
    displayLabel: 'Planner', detailLabel: `Owner · ${owner}`, targetKind: 'cloud-shared-agent', targetAgentId: `cloud_agent_${owner}`, targetOwnerAccountId: owner,
  }) as unknown as SharedCloudAgentMentionCandidate;
  const { shared: unique } = uniqueAgentMentionCandidates([], [shared('acctaaaa'), shared('acctbbbb')]);
  assert.equal(unique[0].handle, 'Planner');
  assert.notEqual(unique[1].normalizedHandle, unique[0].normalizedHandle);
  assert.ok(unique.every((candidate) => candidate.detailLabel.startsWith('Owner · ')), 'the owner shows next to each agent');
});

test('people see the friendly handle; a picked agent is routed by id and a typed one never guesses', () => {
  const collaboration = state([agentPeer('acctother', 'Shu Yang'), agentPeer('acctthird', 'shu yang')]);
  const agents = uniqueAgentMentionCandidates(
    buildCollaborationMentionCandidates(collaboration).filter((c) => c.targetKind === 'agent'), [],
  ).collaboration;
  assert.equal(agents.length, 2);
  assert.notEqual(agents[0].normalizedHandle, agents[1].normalizedHandle, 'unique inside');
  for (const agent of agents) {
    assert.equal((agent.baseHandle ?? agent.handle).toLowerCase(), 'kordishuyang', 'no suffix in what people see');
  }
  // The composer inserts the friendly handle; the picked option names the agent.
  const picked = agents[1];
  const option = { value: picked.baseHandle ?? picked.handle, label: picked.displayLabel, targetKind: 'agent', sourceHostId: 'host',
    nodeId: picked.peer.nodeId, humanId: picked.peer.humanId, agentId: picked.peer.agentId } as unknown as ComposerMentionOption;
  const text = `@${option.value} agree with the plan`;
  assert.equal(selectedComposerAgentMentionTarget(text, option, collaboration)?.peer.agentId, picked.peer.agentId);
  assert.ok(!text.includes(picked.handle) || picked.handle === option.value);
  // Typed without picking, the shared name is ambiguous; a unique name is not.
  assert.equal(typedAgentMentionIsAmbiguous('@KordiShuYang hi', null, collaboration, group, []), true);
  // The viewer ("shu yang") and another "Shu Yang": their agents collide too.
  assert.equal(typedAgentMentionIsAmbiguous('@KordiShuYang hi', null, state([agentPeer('acctother', 'Shu Yang')]), group, []), true);
  assert.equal(typedAgentMentionIsAmbiguous('@KordiSam hi', null, state([agentPeer('acctsam', 'Sam')]), group, []), false);
});

test("a contact who shares a member's name is not offered in a chat they are not in", () => {
  // Without member ids the group lists names only; two known people named
  // "shu yang" make that name undecidable, so neither is offered by name.
  const nameOnly = { ...group, canonicalParticipants: [], participants: ['Viewer', 'shu yang', 'Sam'] } as unknown as Conversation;
  const candidates = buildCollaborationMentionCandidates(state([agentPeer('acctother', 'Shu Yang'), agentPeer('acctmember', 'shu yang'), agentPeer('acctsam', 'Sam')]));
  const byName = filterCollaborationMentionCandidatesForConversation(candidates, nameOnly).filter((c) => c.targetKind === 'agent').map((c) => c.peer.humanId);
  assert.deepEqual(byName, ['acctsam']);
  // With member ids, only the member is offered, never the same-named contact.
  const withIds = { ...group, participants: ['Viewer', 'shu yang'], canonicalParticipants: [
    { id: 'human:acctviewer', name: 'Viewer', kind: 'human', role: 'self', source: 'cloud', humanId: 'acctviewer', sourceIdentityId: 'acctviewer' },
    { id: 'human:acctmember', name: 'shu yang', kind: 'human', role: 'person', source: 'cloud', humanId: 'acctmember', sourceIdentityId: 'acctmember' },
  ] } as unknown as Conversation;
  const byId = filterCollaborationMentionCandidatesForConversation(candidates, withIds).filter((c) => c.targetKind === 'agent').map((c) => c.peer.humanId);
  assert.deepEqual(byId, ['acctmember']);
});
