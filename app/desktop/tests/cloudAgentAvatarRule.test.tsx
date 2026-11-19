import assert from 'node:assert/strict';
import { test } from 'node:test';

import React from 'react';

import { setLocalAgentAvatar } from '../src/features/canonical/localAgentAvatar';
import { mapCanonicalMessage, processingAgentMessage } from '../src/features/canonical/readModel/messageMapping';
import { agentMessageAvatarSeed } from '../src/features/chat/agentMessageAvatar';
import type { CloudAccount, CloudPublicProfile } from '../src/features/cloud/authClient';
import { cloudAvatarImageUrl } from '../src/features/cloud/avatar';
import { generatedAvatarMarker } from '../src/features/cloud/canonicalAvatar';
import { canonicalAgentSenderAvatar, cloudAgentAvatarSeed } from '../src/features/cloud/cloudAgentAvatar';
import { cloudCanonicalDefaultAgentContactFields } from '../src/features/cloud/cloudAgentIdentity';
import { encodeBase64UrlUtf8 } from '../src/features/cloud/cloudBase64Url';
import { cloudContactToAgentPeer, cloudSelfContact } from '../src/features/cloud/cloudContactPeers';
import { cloudGroupParticipantWithAgentAvatar } from '../src/features/cloud/cloudGroupIdentity';
import {
  cloudGroupAgentRequestingNoticeRequest,
  cloudGroupIdentityRequest,
  cloudGroupParticipantFromContact,
  cloudGroupSelfParticipant,
  parseCloudGroupControl,
  type CloudGroupParticipant,
} from '../src/features/cloud/cloudGroupMessages';
import { IdentityAvatar } from '../src/kordi-app/components/IdentityAvatar';
import type {
  AppendCanonicalMessageRequest,
  CanonicalDelegatedExchange,
  CanonicalIdentity,
  CanonicalSessionMessage,
  Contact,
  UpsertCanonicalIdentityRequest,
} from '../src/kordi-app/types';
import { generatedAvatarSeedForLabel } from '../src/lib/identityLabels';
import { account as cloudAccountFixture, agentAvatar, ALEX, applyAgentReply, groupProfileCache, PRIYA } from './helpers/cloudGroupAgentReply';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const PEER = 'acct_1111aaaa2222bbbb3333cccc4444dddd';
const VIEWER = 'acct_5555eeee6666ffff7777aaaa8888bbbb';
const PEER_AGENT_ID = `cloud-agent:${PEER}`;
const PEER_AGENT_IDENTITY_ID = `agent:cloud-agent:${PEER_AGENT_ID}`;
const PEER_DEFAULT_SEED = `default-agent-${PEER}`;
const GROUP_ID = 'session:group:avatar-rule';
const VIEWER_IDENTITY_ID = `human:${VIEWER}`;
const CUSTOM_SEED = 'bird-custom-seed-1';
const CUSTOM_MARKER = generatedAvatarMarker('kordi-birds', CUSTOM_SEED, 3);

const viewerAccount: CloudAccount = {
  accountId: VIEWER,
  displayName: 'Viewer Person',
  primaryEmail: 'viewer@example.com',
  avatarUrl: null,
  avatar: { ...cloudAccountAvatarFixture, entityId: VIEWER, seed: VIEWER },
  nodeId: null,
  passwordSet: true,
};

function envelopeBody(envelope: Record<string, unknown>) {
  return `kordi-cloud-group:${encodeBase64UrlUtf8(JSON.stringify(envelope))}`;
}

function replyMessage(senderKindFields: Record<string, unknown>) {
  return {
    id: 'gmsg_reply_1',
    senderAccountId: PEER,
    text: 'Hello from Kordi',
    createdAtMs: 1_800_000_000_000,
    ...senderKindFields,
  };
}

/** Shaped like an envelope the desktop writes: the seed is on the actor only. */
const desktopBuiltBody = envelopeBody({
  kind: 'group-message',
  groupId: GROUP_ID,
  groupSpaceId: null,
  groupTitle: 'Avatar rule',
  createdByAccountId: VIEWER,
  actor: {
    accountId: PEER, displayName: 'Peer Person', avatarUrl: null, agentId: PEER_AGENT_ID,
    agentDisplayName: 'Kordi', agentAvatarUrl: null, agentAvatarSeed: PEER_DEFAULT_SEED, role: 'person',
  },
  participants: [
    { accountId: VIEWER, displayName: 'Viewer Person', avatarUrl: null, agentId: `cloud-agent:${VIEWER}`, agentDisplayName: 'Kordi', agentAvatarUrl: null, joinedAt: '2026-11-01T00:00:00Z' },
    { accountId: PEER, displayName: 'Peer Person', avatarUrl: null, agentId: PEER_AGENT_ID, agentDisplayName: 'Kordi', agentAvatarUrl: null, joinedAt: '2026-11-01T00:00:01Z' },
  ],
  message: replyMessage({ senderKind: 'agent', senderAgentId: PEER_AGENT_ID, senderDisplayName: 'Kordi' }),
});

/** Shaped like an envelope the cloud runner writes: no seed anywhere. */
const cloudBuiltBody = envelopeBody({
  kind: 'group-message',
  groupId: GROUP_ID,
  createdByAccountId: VIEWER,
  actor: { accountId: PEER, displayName: 'Peer Person', avatarUrl: null, agentId: PEER_AGENT_ID, agentDisplayName: 'Kordi', role: 'person' },
  participants: [
    { accountId: VIEWER, displayName: 'Viewer Person', avatarUrl: null, agentId: `cloud-agent:${VIEWER}`, agentDisplayName: 'Kordi', role: 'admin' },
    { accountId: PEER, displayName: 'Peer Person', avatarUrl: null, agentId: PEER_AGENT_ID, agentDisplayName: 'Kordi', role: 'person' },
  ],
  message: replyMessage({
    senderKind: 'agent', senderAgentId: PEER_AGENT_ID, senderOwnerAccountId: PEER,
    senderDisplayName: 'Kordi', deliveryState: 'complete',
  }),
});

function parsed(body: string) {
  const envelope = parseCloudGroupControl(body);
  assert.ok(envelope);
  return envelope;
}

function storedIdentity(request: UpsertCanonicalIdentityRequest): CanonicalIdentity {
  return { ...request, id: request.id ?? '', createdAtMs: 1, updatedAtMs: 1 } as CanonicalIdentity;
}

function metadataOf(request: UpsertCanonicalIdentityRequest) {
  return request.metadata as Record<string, unknown>;
}

function peerParticipant(body: string): CloudGroupParticipant {
  const participant = parsed(body).participants.find((candidate) => candidate.accountId === PEER);
  assert.ok(participant);
  return participant;
}

const viewerIdentity = storedIdentity({
  id: VIEWER_IDENTITY_ID, kind: 'human', displayName: 'Viewer Person', source: 'local', humanId: VIEWER, avatarKey: VIEWER,
});

/** The stored identity for the peer's default agent, as a group reply writes it. */
const peerAgentIdentity = (profileImageUrl: string | null = null) => storedIdentity({
  id: PEER_AGENT_IDENTITY_ID, kind: 'agent', displayName: 'Kordi', ownerIdentityId: `human:${PEER}`,
  source: 'cloud', sourceHostId: 'cloud', sourceIdentityId: PEER_AGENT_ID, humanId: PEER,
  agentId: PEER_AGENT_ID, avatarKey: PEER_AGENT_ID, profileImageUrl,
  metadata: { accountId: PEER, cloudGroupAgent: true },
});

function identityMap(...identities: CanonicalIdentity[]) {
  return new Map(identities.map((identity) => [identity.id, identity]));
}

function canonicalRow(request: AppendCanonicalMessageRequest, overrides: Partial<CanonicalSessionMessage> = {}): CanonicalSessionMessage {
  return {
    ...request,
    id: request.id ?? 'row',
    status: request.status ?? 'complete',
    sequenceNum: 2,
    createdAtMs: request.createdAtMs ?? 1,
    updatedAtMs: request.createdAtMs ?? 1,
    ...overrides,
  } as CanonicalSessionMessage;
}

/** A request to the peer's agent that failed because the peer has no model provider. */
const failedNoticeRow = canonicalRow(cloudGroupAgentRequestingNoticeRequest({
  sessionId: GROUP_ID, requestMessageId: 'msg:request-1', targetAccountId: PEER,
  targetAgentId: PEER_AGENT_ID, targetAgentDisplayName: 'Kordi', createdAtMs: 1_800_000_000_000,
}), {
  status: 'failed',
  content: {
    sender: 'Kordi', senderOwnerAccountId: PEER, deliveryState: 'failed', failureCode: 'missing_provider_auth',
    error: 'The agent owner has no model provider.', requestId: 'msg:request-1', replyToMessageId: 'msg:request-1',
  },
});

function agentReplyRow(id: string, sourceTransport: string, content: Record<string, unknown>): CanonicalSessionMessage {
  return {
    id, sessionId: GROUP_ID, senderIdentityId: PEER_AGENT_IDENTITY_ID, senderRole: 'external-agent',
    messageKind: 'agent-turn', contentText: 'Hello from Kordi', content: { sender: 'Kordi', deliveryState: 'complete', ...content },
    status: 'complete', sequenceNum: 3, createdAtMs: 2, updatedAtMs: 2, sourceTransport,
  };
}

function rowAvatar(row: CanonicalSessionMessage, identities: Map<string, CanonicalIdentity>, viewerIdentityId = VIEWER_IDENTITY_ID) {
  const message = mapCanonicalMessage(row, identities, viewerIdentityId);
  assert.ok(message, `row ${row.id} maps to a transcript message`);
  return { seed: message.senderAvatarSeed ?? null, imageUrl: message.senderProfileImageUrl ?? null, message };
}

test('desktop-built and cloud-built envelopes store the same default agent seed for a member', () => {
  for (const body of [desktopBuiltBody, cloudBuiltBody]) {
    const envelope = parsed(body);
    for (const participant of [envelope.actor, ...envelope.participants]) {
      const request = cloudGroupIdentityRequest(participant, viewerAccount, VIEWER_IDENTITY_ID);
      assert.equal(
        metadataOf(request).defaultAgentAvatarSeed,
        `default-agent-${participant.accountId}`,
        `${participant.accountId} in a ${body === desktopBuiltBody ? 'desktop' : 'cloud'}-built envelope`,
      );
    }
  }
});

/** The peer's member identity, with what contact sync stored about their default agent. */
const peerOwnerIdentity = (metadata?: Record<string, unknown>) => storedIdentity({
  id: `human:${PEER}`, kind: 'human', displayName: 'Peer Person', source: 'cloud', humanId: PEER, avatarKey: PEER, metadata,
});

const peerProfileMetadata = {
  accountId: PEER, defaultAgentId: PEER_AGENT_ID, defaultAgentAvatarSeed: CUSTOM_SEED, defaultAgentAvatarUrl: CUSTOM_MARKER,
};

test('a failed request row to an unseen agent takes the owner profile avatar', () => {
  const { seed, imageUrl } = rowAvatar(failedNoticeRow, identityMap(viewerIdentity, peerOwnerIdentity(peerProfileMetadata)));
  assert.equal(seed, CUSTOM_SEED);
  assert.equal(imageUrl, cloudAvatarImageUrl(CUSTOM_MARKER));
});

test('a failed request row with no stored profile uses the server default seed, not a name hash', () => {
  for (const identities of [identityMap(viewerIdentity), identityMap(viewerIdentity, peerOwnerIdentity())]) {
    const { seed, imageUrl, message } = rowAvatar(failedNoticeRow, identities);
    assert.equal(seed, PEER_DEFAULT_SEED);
    assert.equal(imageUrl, null);
    const drawn = agentMessageAvatarSeed(message, `default-agent-${VIEWER}`, message.sender);
    assert.equal(drawn, PEER_DEFAULT_SEED);
    assert.notEqual(drawn, generatedAvatarSeedForLabel('agent', 'Kordi'));
  }
});

test('desktop-built and cloud-built replies and a failure notice from one agent draw one avatar', () => {
  const avatars = [desktopBuiltBody, cloudBuiltBody].flatMap((body) => {
    const owner = storedIdentity(cloudGroupIdentityRequest(peerParticipant(body), viewerAccount, VIEWER_IDENTITY_ID));
    const identities = identityMap(viewerIdentity, owner, peerAgentIdentity());
    const notice = rowAvatar(failedNoticeRow, identityMap(viewerIdentity, owner));
    const desktopReply = rowAvatar(agentReplyRow('reply-desktop', 'cloud-group', { cloudGroupMessageId: 'gmsg_reply_1' }), identities);
    const cloudReply = rowAvatar(agentReplyRow('reply-cloud', 'cloud-group-agent', {
      senderOwnerAccountId: PEER, cloudGroupMessageId: 'gmsg_reply_2', cloudMessageVersion: 1,
    }), identities);
    return [notice, desktopReply, cloudReply].map(({ seed, imageUrl }) => ({ seed, imageUrl }));
  });
  for (const avatar of avatars) assert.deepEqual(avatar, { seed: PEER_DEFAULT_SEED, imageUrl: null });
});

test('a waiting row for a default agent uses the server default seed', () => {
  const target = peerAgentIdentity();
  const exchange: CanonicalDelegatedExchange = {
    id: 'exchange-1', sessionId: GROUP_ID, initiatorIdentityId: VIEWER_IDENTITY_ID, targetIdentityId: target.id,
    requestMessageId: 'msg:request-1', transport: 'cloud', contextPolicy: 'last-message', status: 'processing',
    createdAtMs: 1, updatedAtMs: 1,
  };
  const row = processingAgentMessage(exchange, target, identityMap(viewerIdentity, target), VIEWER_IDENTITY_ID);
  assert.equal(row.senderAvatarSeed, PEER_DEFAULT_SEED);
});

test('an agent avatar drawn from a default agent id shows the profile default bird', async () => {
  setLocalAgentAvatar(null);
  await withJsdomRoot(async (mount) => {
    const agent = await mount(<IdentityAvatar kind="agent" seed={PEER_AGENT_ID} name="Kordi" />);
    const src = agent.querySelector('img')?.getAttribute('src') ?? '';
    assert.ok(src.includes(`/v1/avatars/preview/kordi-birds/${PEER_DEFAULT_SEED}.png`), src);

    const human = await mount(<IdentityAvatar kind="human" seed={PEER_AGENT_ID} name="Peer Person" />);
    assert.ok(!(human.querySelector('img')?.getAttribute('src') ?? '').includes('default-agent-'));
  });
});

test('a member profile restores the default agent avatar a seedless envelope does not carry', () => {
  const participant = peerParticipant(cloudBuiltBody);
  const profile: Pick<CloudPublicProfile, 'accountId' | 'defaultAgent'> = {
    accountId: PEER,
    defaultAgent: {
      agentId: PEER_AGENT_ID, displayName: 'Kordi', avatarUrl: CUSTOM_MARKER,
      avatar: agentAvatar(PEER, { style: 'kordi-birds', seed: CUSTOM_SEED, version: 3 }),
    },
  };
  const request = (member: CloudGroupParticipant) => cloudGroupIdentityRequest(member, viewerAccount, VIEWER_IDENTITY_ID);
  const restored = cloudGroupParticipantWithAgentAvatar(participant, profile);
  assert.deepEqual(
    { ...restored, agentAvatarUrl: null, agentAvatarSeed: null },
    { ...participant, agentAvatarUrl: null, agentAvatarSeed: null },
    'only the two avatar fields change',
  );
  const fromProfile = metadataOf(request(restored));
  assert.equal(fromProfile.defaultAgentAvatarSeed, CUSTOM_SEED);
  assert.equal(fromProfile.defaultAgentAvatarUrl, CUSTOM_MARKER);

  const stored = storedIdentity(request(restored));
  const kept = metadataOf(request(cloudGroupParticipantWithAgentAvatar(participant, null, stored)));
  assert.equal(kept.defaultAgentAvatarSeed, CUSTOM_SEED);
  assert.equal(kept.defaultAgentAvatarUrl, CUSTOM_MARKER);

  const legacy = peerOwnerIdentity({ defaultAgentId: PEER_AGENT_ID, defaultAgentAvatarSeed: PEER_AGENT_ID, defaultAgentAvatarUrl: null });
  const repaired = metadataOf(request(cloudGroupParticipantWithAgentAvatar(participant, null, legacy)));
  assert.equal(repaired.defaultAgentAvatarSeed, PEER_DEFAULT_SEED);
  assert.equal(repaired.defaultAgentAvatarUrl, null);
});

test('the group pipeline stores the member profile avatar, and a reply and a failure notice draw it alike', async () => {
  const priya = cloudAccountFixture(PRIYA, 'Priya Tester', agentAvatar(PRIYA, { style: 'kordi-birds', seed: CUSTOM_SEED, version: 3 }));
  const alex = cloudAccountFixture(ALEX, 'Alex Tester', agentAvatar(ALEX));
  const state = await applyAgentReply(alex, priya, alex, groupProfileCache(alex, priya, alex));
  const metadataFor = (accountId: string) => state.identities.find((identity) => identity.id === `human:${accountId}`)?.metadata as Record<string, unknown>;
  assert.equal(metadataFor(PRIYA).defaultAgentAvatarSeed, CUSTOM_SEED);
  assert.equal(metadataFor(PRIYA).defaultAgentAvatarUrl, priya.defaultAgent?.avatarUrl);
  assert.equal(metadataFor(ALEX).defaultAgentAvatarSeed, `default-agent-${ALEX}`);

  const identities = identityMap(...state.identities);
  const reply = state.messages.find((message) => message.senderIdentityId.startsWith('agent:'));
  assert.ok(reply);
  const notice = canonicalRow(cloudGroupAgentRequestingNoticeRequest({
    sessionId: reply.sessionId, requestMessageId: 'msg:request-2', targetAccountId: PRIYA,
    targetAgentId: `cloud-agent:${PRIYA}`, targetAgentDisplayName: "Priya Tester's Kordi", createdAtMs: 20,
  }));
  const withoutAgents = identityMap(...state.identities.filter((identity) => identity.kind !== 'agent'));
  const expected = { seed: CUSTOM_SEED, imageUrl: cloudAvatarImageUrl(priya.defaultAgent?.avatarUrl) };
  for (const [row, rowIdentities] of [[reply, identities], [notice, withoutAgents]] as const) {
    const { seed, imageUrl } = rowAvatar(row, rowIdentities, `human:${ALEX}`);
    assert.deepEqual({ seed, imageUrl }, expected, row.id);
  }
});

test('the seed rule prefers a valid profile seed, then the server default, then the agent id', () => {
  assert.equal(cloudAgentAvatarSeed({ agentId: PEER_AGENT_ID, ownerAccountId: PEER, profileSeed: CUSTOM_SEED }), CUSTOM_SEED);
  assert.equal(cloudAgentAvatarSeed({ agentId: PEER_AGENT_ID, ownerAccountId: PEER, profileSeed: PEER_AGENT_ID }), PEER_DEFAULT_SEED);
  assert.equal(cloudAgentAvatarSeed({ agentId: 'cloud_agent_custom_1', ownerAccountId: PEER }), 'cloud_agent_custom_1');
  for (const agentId of [null, '', `cloud-self:${PEER}`, 'local:0123abcd', 'cloud-local-agent']) {
    assert.equal(cloudAgentAvatarSeed({ agentId, ownerAccountId: PEER }), PEER_DEFAULT_SEED, String(agentId));
  }
});

test('the sender resolver reads legacy ids and applies a profile only to that owner default agent', () => {
  const identities = identityMap(peerOwnerIdentity(peerProfileMetadata));
  const profileAvatar = { seed: CUSTOM_SEED, imageUrl: cloudAvatarImageUrl(CUSTOM_MARKER) };
  assert.deepEqual(canonicalAgentSenderAvatar({ senderIdentityId: `agent:cloud:${PEER}`, identityById: identities }), profileAvatar);
  assert.deepEqual(canonicalAgentSenderAvatar({ senderIdentityId: PEER_AGENT_IDENTITY_ID, identityById: identities }), profileAvatar);
  const otherAgent = storedIdentity({
    id: 'agent:cloud-agent:cloud_agent_custom_1', kind: 'agent', displayName: 'Helper', source: 'cloud',
    humanId: PEER, agentId: 'cloud_agent_custom_1', avatarKey: 'cloud_agent_custom_1',
  });
  assert.deepEqual(canonicalAgentSenderAvatar({ identity: otherAgent, identityById: identities }), { seed: 'cloud_agent_custom_1', imageUrl: null });
  assert.deepEqual(canonicalAgentSenderAvatar({ senderIdentityId: `human:${PEER}`, identityById: identities }), { seed: null, imageUrl: null });
});

test('participant and contact builders never store an agent id as a seed', () => {
  const contact = {
    id: `cloud:${PEER}`, name: 'Peer Person', initials: 'PE', classType: 'other-users', entityType: 'user',
    subtitle: PEER, collaborationSources: ['cloud'], status: 'online', discoverableOn: ['cloud'], detail: PEER,
    owner: 'Peer Person', sourceHostId: 'cloud', sourceParticipantId: PEER, sourceHumanId: PEER, contactStatus: 'accepted',
    avatarSeed: PEER, profileImageUrl: null, targetCloudAgentId: PEER_AGENT_ID, targetCloudAgentAvatarSeed: PEER_AGENT_ID,
  } as Contact;
  assert.equal(cloudGroupSelfParticipant(viewerAccount).agentAvatarSeed, `default-agent-${VIEWER}`);
  assert.equal(cloudSelfContact(viewerAccount).targetCloudAgentAvatarSeed, `default-agent-${VIEWER}`);
  assert.equal(cloudGroupParticipantFromContact(contact)?.agentAvatarSeed, PEER_DEFAULT_SEED);
  assert.equal(cloudContactToAgentPeer(contact).avatarSeed, PEER_DEFAULT_SEED);
  const legacyOwner = peerOwnerIdentity({ defaultAgentId: PEER_AGENT_ID, defaultAgentAvatarSeed: PEER_AGENT_ID });
  assert.equal(cloudCanonicalDefaultAgentContactFields(legacyOwner, PEER).targetCloudAgentAvatarSeed, PEER_DEFAULT_SEED);
  assert.equal(cloudCanonicalDefaultAgentContactFields(peerOwnerIdentity(peerProfileMetadata), PEER).targetCloudAgentAvatarSeed, CUSTOM_SEED);
});
