import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { forgetCloudGroupMemberListsForTests } from '../src/features/cloud/cloudGroupMemberLists';
import { removeDepartedCloudGroupParticipants } from '../src/features/cloud/cloudGroupMemberReconciliation';
import type { CloudGroupControlEnvelope } from '../src/features/cloud/cloudGroupMessages';
import { resolveCloudGroupAdminSnapshot } from '../src/features/cloud/cloudGroupSessionPolicy';
import {
  GROUP,
  CONVERSATION_ID,
  LEE,
  KIM,
  MAYA,
  DELETED_AT,
  profile,
  names,
  member,
  webWindow,
  applyEnvelope,
  applyMessage,
  groupTile,
  withSession,
  STUDIO,
  beforeDeletion,
  loadCatalog,
  channel,
} from './helpers/deletedAccountGroupWindow';
import { STAND_IN, syncMember, syncMessage, VIEWER } from './helpers/deletedAccountChatFixtures';

// A group whose creator was deleted keeps its title and passes to its owner. Each test is its own window: no member list carries over.
beforeEach(() => forgetCloudGroupMemberListsForTests());

test('a fresh load of a group whose creator was deleted keeps its channel title and its owner as admin', () => withSession(async () => {
  const window = webWindow([]);
  // An admin listed before the heir must not take the group over from its owner.
  await loadCatalog(window, {
    ...STUDIO, created_by_account_id: STAND_IN,
    members: [member(VIEWER), member(LEE, 'active', { role: 'admin' }), member(KIM, 'active', { role: 'owner' }), syncMember(STAND_IN, 'left', { display_name: 'Deleted account' })],
  });
  const loaded = channel(window.local);
  assert.equal(loaded.name, 'Studio plans');
  assert.notEqual(loaded.name, 'Channel 1');
  assert.equal(loaded.creator, `human:${KIM}`);
  assert.deepEqual([...loaded.admins].sort(), [`human:${KIM}`, `human:${LEE}`]);
  assert.deepEqual(groupTile(window.local), ['Kim Sample', 'Lee Sample', 'Me']);
  assert.equal(window.local?.identities.some((identity) => identity.id === `human:${STAND_IN}`), false);
}));

test('an open group keeps its title through the deletion, and its new owner can rename it', () => withSession(async () => {
  const window = webWindow([profile(LEE, 'Lee Sample'), profile(KIM, 'Kim Sample'), profile(MAYA, 'Maya Sample')]);
  await loadCatalog(window, {
    ...STUDIO, ...beforeDeletion, shared_title: 'Studio plans', group_title: 'Studio', created_by_account_id: MAYA,
    members: [member(VIEWER), member(LEE), member(KIM), member(MAYA, 'active', { role: 'owner' })],
  });
  assert.deepEqual([channel(window.local).name, channel(window.local).creator], ['Studio plans', `human:${MAYA}`]);

  const handedOver = {
    ...STUDIO, created_by_account_id: STAND_IN,
    members: [member(VIEWER), member(LEE), member(KIM, 'active', { role: 'owner' }), syncMember(STAND_IN, 'left', { display_name: 'Deleted account' })],
  };
  await removeDepartedCloudGroupParticipants({
    conversation: handedOver, viewerAccountId: VIEWER, getState: () => window.local,
    setState: (update) => window.setState(update), persistence: window.persistence,
  });
  await applyMessage(window, syncMessage(2, CONVERSATION_ID, STAND_IN, 'Bring snacks'), handedOver);
  await applyMessage(window, syncMessage(3, CONVERSATION_ID, LEE, 'Saturday works'), handedOver);
  const kept = channel(window.local);
  assert.deepEqual([kept.name, kept.creator], ['Studio plans', `human:${KIM}`]);
  assert.ok(kept.admins.includes(`human:${KIM}`));
  assert.equal(kept.admins.includes(`human:${STAND_IN}`), false, 'the stand-in is never an admin');
  assert.deepEqual(groupTile(window.local), ['Kim Sample', 'Lee Sample', 'Me']);

  // Kim, the owner now, renames the channel; Maya's stored role no longer decides it.
  const person = (accountId: string) => ({ accountId, displayName: names[accountId] ?? accountId, avatarUrl: null, role: 'person' });
  await applyEnvelope(window, {
    kind: 'session-title-update', groupId: GROUP, createdByAccountId: MAYA, actor: person(KIM),
    participants: [person(VIEWER), person(LEE), person(KIM)],
    sessionTitle: {
      title: 'Studio plans, Saturday', titleSource: 'manual', titleRevision: 9, titlePolicyVersion: 1,
      updatedAtMs: Date.parse(DELETED_AT) + 60_000, updatedByAccountId: KIM,
    },
  } as CloudGroupControlEnvelope, {
    messageId: 'wire:rename', fromAccountId: KIM, toAccountId: VIEWER, body: '', createdAt: '2026-11-18T10:01:00Z',
    deliveredAt: null, readAt: null, direction: 'incoming' as const, sessionId: GROUP,
  });
  assert.equal(channel(window.local).name, 'Studio plans, Saturday');
  assert.equal(channel(window.local).admins.includes(`human:${STAND_IN}`), false);
}));

test('the stand-in is never an admin, and an owner counts as one', () => {
  const person = (accountId: string, role: string) => ({ accountId, displayName: accountId, avatarUrl: null, role });
  const identityIdByAccount = new Map([[KIM, `human:${KIM}`], [LEE, `human:${LEE}`], [STAND_IN, `human:${STAND_IN}`]]);
  const snapshot = resolveCloudGroupAdminSnapshot({
    envelope: { kind: 'group-invite', createdByAccountId: STAND_IN, actor: person(KIM, 'owner'), participants: [person(KIM, 'owner'), person(LEE, 'member')] },
    identityIdByAccount, createdByIdentityId: `human:${KIM}`, existingAdminIdentityIds: [`human:${STAND_IN}`],
    hasExistingSession: false, controlCreatedAtMs: 10, storedAdminUpdatedAtMs: 0,
  });
  assert.equal(snapshot.applies, true);
  assert.deepEqual(snapshot.adminIdentityIds, [`human:${KIM}`]);
  const kept = resolveCloudGroupAdminSnapshot({
    envelope: { kind: 'group-message', createdByAccountId: STAND_IN, actor: person(STAND_IN, 'member'), participants: [person(KIM, 'owner')] },
    identityIdByAccount, createdByIdentityId: `human:${KIM}`, existingAdminIdentityIds: [`human:${STAND_IN}`, `human:${LEE}`],
    hasExistingSession: true, controlCreatedAtMs: 10, storedAdminUpdatedAtMs: 0,
  });
  assert.deepEqual(kept.adminIdentityIds, [`human:${KIM}`, `human:${LEE}`]);
  // A creator's invite that lists an owner makes that owner an admin, like an admin.
  const invited = resolveCloudGroupAdminSnapshot({
    envelope: { kind: 'group-invite', createdByAccountId: LEE, actor: person(LEE, 'admin'), participants: [person(LEE, 'admin'), person(KIM, 'owner')] },
    identityIdByAccount, createdByIdentityId: `human:${LEE}`, existingAdminIdentityIds: [],
    hasExistingSession: false, controlCreatedAtMs: 10, storedAdminUpdatedAtMs: 0,
  });
  assert.deepEqual(invited.adminIdentityIds, [`human:${LEE}`, `human:${KIM}`]);
});
