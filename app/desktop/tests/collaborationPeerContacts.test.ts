import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addCollaborationPeerContacts } from '../src/app/viewModels/collaborationPeerContacts';
import type { CloudAccount } from '../src/features/cloud/authClient';
import { buildCloudCollaborationHost } from '../src/features/cloud/cloudCollaborationState';
import { cloudContactToContact } from '../src/features/cloud/cloudContactMapping';
import {
  buildChatCreatePeopleContactLookup,
  contactCanonicalIdentityRequest,
} from '../src/features/chat/chatCreateFlows';
import type { Contact } from '../src/kordi-app/types';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  avatar: cloudAccountAvatarFixture,
  nodeId: 'node_me',
  passwordSet: true,
};

const personPhotoUrl = 'https://images.example.com/peer-photo.jpg';
const agentBirdUrl = 'https://images.example.com/peer-agent-bird.png';

const peerContact = cloudContactToContact({
  accountId: 'acct_peer',
  displayName: 'Peer Person',
  avatarUrl: personPhotoUrl,
  defaultAgent: {
    agentId: 'cloud-agent:acct_peer',
    displayName: 'Kordi',
    avatarUrl: agentBirdUrl,
    avatar: {
      ...cloudAccountAvatarFixture,
      entityType: 'agent',
      entityId: 'cloud-agent:acct_peer',
      style: 'kordi-birds',
      seed: 'bird-cockatoo-color-sakura',
    },
  },
  nodeId: null,
  createdAt: '2026-11-08T00:00:00Z',
});

function directoryContacts(contacts: Contact[]) {
  const byId = new Map<string, Contact>();
  addCollaborationPeerContacts(byId, buildCloudCollaborationHost(account, contacts), 'kordi.cloud');
  return byId;
}

test('a cloud contact keeps their own photo, not their agent bird, in the people directory', () => {
  const byId = directoryContacts([peerContact]);
  const person = byId.get('collaboration-peer-person:acct_peer:acct_peer');
  const agent = byId.get('collaboration-peer-agent:acct_peer:cloud-agent:acct_peer');

  assert.equal(person?.profileImageUrl, personPhotoUrl);
  assert.notEqual(person?.avatarSeed, 'bird-cockatoo-color-sakura');
  assert.equal(agent?.profileImageUrl, agentBirdUrl);
});

test('a group member added from contacts gets their own photo on the member identity', () => {
  const lookup = buildChatCreatePeopleContactLookup([...directoryContacts([peerContact]).values()]);
  const member = lookup.get('cloud:acct_peer');
  assert.ok(member);

  const identity = contactCanonicalIdentityRequest(member);
  assert.equal(identity.id, 'human:acct_peer');
  assert.equal(identity.profileImageUrl, personPhotoUrl);
});

test('an owner known only through their agent gets the letter fallback, not the agent bird', () => {
  const host = buildCloudCollaborationHost(account, [peerContact]);
  const agentOnlyHost = {
    ...host,
    visiblePeers: host.visiblePeers.filter((peer) => peer.agentId),
  };
  const byId = new Map<string, Contact>();
  addCollaborationPeerContacts(byId, agentOnlyHost, 'kordi.cloud');
  const owner = byId.get('collaboration-peer-person:acct_peer:acct_peer');

  assert.equal(owner?.profileImageUrl, null);
  assert.equal(owner?.avatarSeed, 'acct_peer');
});
