import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import type { CloudSyncEvent } from '../src/features/cloud/authClient';
import { cloudMessageFromChatSync } from '../src/features/cloud/chatSyncMapping';
import { applyCloudSyncEventsToMessagesByPeer } from '../src/features/cloud/cloudDiffSyncMessages';
import { publishCloudGroupCatalog, subscribeCloudGroupCatalog } from '../src/features/cloud/cloudGroupCatalogSync';
import { forgetCloudGroupMemberListsForTests } from '../src/features/cloud/cloudGroupMemberLists';
import { cloudGroupDepartedParticipantIdentityIds, removeDepartedCloudGroupParticipants } from '../src/features/cloud/cloudGroupMemberReconciliation';
import type { CloudGroupControlEnvelope } from '../src/features/cloud/cloudGroupMessages';
import { refreshCloudGroupProfiles } from '../src/features/cloud/cloudGroupProfileRefresh';
import {
  GROUP,
  CONVERSATION_ID,
  LEE,
  KIM,
  MAYA,
  DELETED_AT,
  profile,
  member,
  beforeDeletion,
  afterDeletion,
  webWindow,
  applyEnvelope,
  applyMessage,
  groupTile,
  staleCopy,
  withSession,
} from './helpers/deletedAccountGroupWindow';
import { STAND_IN, syncMember, syncMessage, VIEWER, viewerAccount } from './helpers/deletedAccountChatFixtures';

// An open group drops a deleted member without a reload. Each test is its own window: no member list carries over.
beforeEach(() => forgetCloudGroupMemberListsForTests());

test('a group open before an account was deleted drops its member without a reload', () => withSession(async () => {
  const window = webWindow([profile(LEE, 'Lee Sample'), profile(KIM, 'Kim Sample'), profile(MAYA, 'Maya Sample')]);
  await applyMessage(window, syncMessage(1, CONVERSATION_ID, LEE, 'Saturday works'), beforeDeletion);
  assert.deepEqual(groupTile(window.local), ['Kim Sample', 'Lee Sample', 'Maya Sample', 'Me']);

  // membership.updated: the new member list replaces the old one.
  assert.deepEqual(cloudGroupDepartedParticipantIdentityIds(window.local, afterDeletion, VIEWER), [`human:${MAYA}`]);
  const removed = await removeDepartedCloudGroupParticipants({
    conversation: afterDeletion, viewerAccountId: VIEWER, getState: () => window.local,
    setState: (update) => window.setState(update), persistence: window.persistence,
  });
  assert.deepEqual(removed, [`human:${MAYA}`]);
  assert.equal(window.store.participants.find((row) => row.identityId === `human:${MAYA}`)?.state, 'left');

  // message.updated: Maya's message now comes from the stand-in, and a stale copy still names her.
  const moved = await applyMessage(window, syncMessage(2, CONVERSATION_ID, STAND_IN, 'Bring snacks'), afterDeletion);
  assert.deepEqual([moved.actor.accountId, moved.actor.displayName], [STAND_IN, 'Deleted account']);
  assert.equal(moved.participants.some((participant) => participant.accountId === STAND_IN || participant.accountId === MAYA), false);
  const stale = await applyMessage(window, { ...syncMessage(3, CONVERSATION_ID, LEE, ''), content: { schema: 1, blocks: [{ type: 'text', text: staleCopy('See you all', [VIEWER, LEE, KIM, MAYA]) }] } }, afterDeletion);
  assert.deepEqual(stale.participants.map((participant) => participant.accountId), [VIEWER, LEE, KIM]);

  assert.deepEqual(groupTile(window.local), ['Kim Sample', 'Lee Sample', 'Me']);
  assert.equal(window.local?.identities.find((identity) => identity.id === `human:${STAND_IN}`)?.displayName, 'Deleted account');
  assert.deepEqual(window.fetched, [], 'no profile is fetched for the stand-in or the deleted account');
}));

test('a group whose creator was deleted passes to its owner and does not add the creator back', () => withSession(async () => {
  const window = webWindow([profile(LEE, 'Lee Sample'), profile(KIM, 'Kim Sample'), profile(MAYA, 'Maya Sample')]);
  const createdByMaya = {
    ...beforeDeletion, created_by_account_id: MAYA,
    members: [member(VIEWER), member(LEE), member(KIM), member(MAYA, 'active', { role: 'owner' })],
  };
  await applyMessage(window, syncMessage(1, CONVERSATION_ID, LEE, 'Saturday works'), createdByMaya);
  assert.equal(window.local?.sessions.find((session) => session.id === GROUP)?.createdByIdentityId, `human:${MAYA}`);

  // The server hands ownership to Lee and names the stand-in as the creator.
  const handedOver = {
    ...afterDeletion, created_by_account_id: STAND_IN,
    members: [member(VIEWER), member(LEE, 'active', { role: 'owner' }), member(KIM), syncMember(STAND_IN, 'left', { display_name: 'Deleted account' })],
  };
  await removeDepartedCloudGroupParticipants({
    conversation: handedOver, viewerAccountId: VIEWER, getState: () => window.local,
    setState: (update) => window.setState(update), persistence: window.persistence,
  });
  await applyMessage(window, syncMessage(2, CONVERSATION_ID, STAND_IN, 'Bring snacks'), handedOver);
  await applyMessage(window, { ...syncMessage(3, CONVERSATION_ID, KIM, ''), content: { schema: 1, blocks: [{ type: 'text', text: staleCopy('See you all', [VIEWER, LEE, KIM, MAYA]) }] } }, handedOver);

  assert.equal(window.local?.sessions.find((session) => session.id === GROUP)?.createdByIdentityId, `human:${LEE}`);
  assert.deepEqual(groupTile(window.local), ['Kim Sample', 'Lee Sample', 'Me']);
  assert.deepEqual(window.fetched, []);
}));

test('a member list never removes the viewer, a member added since, or anyone while the viewer is gone', () => withSession(async () => {
  const window = webWindow([profile(LEE, 'Lee Sample'), profile(KIM, 'Kim Sample'), profile(MAYA, 'Maya Sample')]);
  await applyMessage(window, syncMessage(1, CONVERSATION_ID, LEE, 'Saturday works'), beforeDeletion);
  const state = window.local;
  assert.ok(state);
  const olderList = { ...afterDeletion, updated_at: '1970-01-01T00:00:00.500Z' };
  assert.deepEqual(cloudGroupDepartedParticipantIdentityIds(state, olderList, VIEWER), [], 'members joined after the list was written stay');
  const viewerGone = { ...afterDeletion, members: afterDeletion.members.filter((row) => row.account_id !== VIEWER) };
  assert.deepEqual(cloudGroupDepartedParticipantIdentityIds(state, viewerGone, VIEWER), []);
  assert.deepEqual(cloudGroupDepartedParticipantIdentityIds(state, beforeDeletion, VIEWER), []);
  // A departed member's group agent goes too.
  const mayaAgent = {
    id: 'agent:maya', kind: 'agent', displayName: "Maya's Kordi", source: 'cloud', humanId: MAYA, avatarKey: 'agent:maya',
    metadata: { cloudGroupAgent: true }, createdAtMs: 1, updatedAtMs: 1,
  };
  const withAgent = {
    ...state,
    identities: [...state.identities, mayaAgent],
    participants: [...state.participants, { sessionId: GROUP, identityId: mayaAgent.id, role: 'external-agent', state: 'active', addedAtMs: 1 }],
  };
  assert.deepEqual(cloudGroupDepartedParticipantIdentityIds(withAgent, afterDeletion, VIEWER), [`human:${MAYA}`, mayaAgent.id]);
}));

test('an account whose profile answered 404 is not asked for again', () => withSession(async () => {
  const gone = 'acct_gone_404';
  const window = webWindow([profile(LEE, 'Lee Sample')], [gone]);
  const person = (accountId: string) => ({ accountId, displayName: accountId, avatarUrl: null, role: 'member' });
  const row = (id: string): CloudGroupControlEnvelope => ({
    kind: 'group-message', groupId: GROUP, createdByAccountId: VIEWER, actor: person(LEE),
    participants: [person(VIEWER), person(LEE), person(gone)],
    message: { id, senderAccountId: LEE, text: 'Hello', createdAtMs: 1, senderKind: 'human', senderDisplayName: 'Lee Sample' },
  } as CloudGroupControlEnvelope);
  await applyEnvelope(window, row('msg:one'));
  await applyEnvelope(window, row('msg:two'));
  await applyEnvelope(window, row('msg:three'));
  assert.deepEqual(window.fetched, [gone]);

  // A directory change for an account that is gone drops it from the cache, so it is not asked again.
  const goneAgain = 'acct_gone_refresh';
  const refreshWindow = webWindow([profile(goneAgain, 'Gone Sample')], [goneAgain]);
  const refresh = () => refreshCloudGroupProfiles({
    accountIds: [goneAgain], token: 'rowan-token', account: viewerAccount, client: refreshWindow.client,
    profileCache: refreshWindow.profileCache, preparationCache: new Map(), getState: () => null, setState: () => undefined,
  });
  assert.deepEqual(await refresh(), []);
  assert.equal(refreshWindow.profileCache.has(goneAgain), false);
  await refresh();
  assert.deepEqual(refreshWindow.fetched, [goneAgain]);
}));

test('live member lists reconcile an open group once per version', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: new EventTarget() });
  const reconciled: number[] = [];
  const applied: string[] = [];
  let hasGroup = true;
  const unsubscribe = subscribeCloudGroupCatalog({
    accountId: VIEWER,
    hasSession: () => hasGroup,
    rememberConversations: () => undefined,
    applyRow: async (row) => { applied.push(row.envelope.groupId); },
    reconcileMembers: async (conversation) => { reconciled.push(conversation.version); },
    reportError: (error) => { throw error; },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    // A batch repeats the snapshot for every changed message.
    publishCloudGroupCatalog(VIEWER, [afterDeletion, afterDeletion, afterDeletion, beforeDeletion]);
    await settle();
    assert.deepEqual(reconciled, [2]);
    publishCloudGroupCatalog(VIEWER, [{ ...afterDeletion, version: 3 }]);
    await settle();
    assert.deepEqual(reconciled, [2, 3]);
    assert.deepEqual(applied, [], 'an existing open group is not rebuilt');
    // A group this window does not hold yet is created from the list, not reconciled.
    hasGroup = false;
    publishCloudGroupCatalog(VIEWER, [{ ...afterDeletion, version: 4 }]);
    await settle();
    assert.deepEqual([applied, reconciled], [[GROUP], [2, 3]]);
  } finally {
    unsubscribe();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test("a moved group message leaves the deleted account's list instead of staying there twice", () => {
  const before = cloudMessageFromChatSync(syncMessage(4, CONVERSATION_ID, MAYA, 'Bring snacks'), beforeDeletion, VIEWER);
  const fromLee = cloudMessageFromChatSync(syncMessage(5, CONVERSATION_ID, LEE, 'Saturday works'), beforeDeletion, VIEWER);
  const after = cloudMessageFromChatSync({ ...syncMessage(4, CONVERSATION_ID, STAND_IN, 'Bring snacks'), version: 3 }, afterDeletion, VIEWER);
  const upsert: CloudSyncEvent = {
    eventId: 'updated-4', eventType: 'message.upsert', peerAccountId: STAND_IN, messageId: after.messageId,
    payload: { message: after }, occurredAt: DELETED_AT,
  };
  const next = applyCloudSyncEventsToMessagesByPeer(VIEWER, { [MAYA]: [before], [LEE]: [fromLee] }, [upsert]);
  assert.deepEqual(Object.keys(next).sort(), [STAND_IN, LEE].sort());
  assert.deepEqual(next[STAND_IN]?.map((message) => [message.messageId, message.fromAccountId]), [[after.messageId, STAND_IN]]);
  assert.strictEqual(next[LEE]?.[0], fromLee, 'other lists are untouched');
});
