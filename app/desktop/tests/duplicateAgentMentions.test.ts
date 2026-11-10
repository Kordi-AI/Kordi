import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCollaborationMentionCandidates,
  resolveMentionedCollaborationTarget,
  uniqueAgentMentionCandidates,
  type SharedCloudAgentMentionCandidate,
} from '../src/features/chat/messageActions/mentions';
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
