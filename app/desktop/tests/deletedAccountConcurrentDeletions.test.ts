import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import type { CloudPublicProfile } from '../src/features/cloud/authClient';
import type { ChatSyncConversation, ChatSyncMessage } from '../src/features/cloud/chatSyncTypes';
import { publishCloudGroupCatalog, subscribeCloudGroupCatalog } from '../src/features/cloud/cloudGroupCatalogSync';
import { forgetCloudGroupMemberListsForTests } from '../src/features/cloud/cloudGroupMemberLists';
import { removeDepartedCloudGroupParticipants } from '../src/features/cloud/cloudGroupMemberReconciliation';
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
  groupConversation,
  webWindow,
  applyMessage,
  groupTile,
  withSession,
} from './helpers/deletedAccountGroupWindow';
import { STAND_IN, syncMember, syncMessage, VIEWER } from './helpers/deletedAccountChatFixtures';

// Two members deleted moments apart both leave an open group. Each test is its own window: no member list carries over.
beforeEach(() => forgetCloudGroupMemberListsForTests());

const ADA = 'acct_ada';
names[ADA] = 'Ada Sample';

/** Rowan, Lee, Kim, Maya and Ada; Maya and Ada are deleted moments apart. */
function crewList(version: number, gone: readonly string[], updatedAt: string): ChatSyncConversation {
  const stillHere = [VIEWER, LEE, KIM, MAYA, ADA].filter((accountId) => !gone.includes(accountId));
  return groupConversation(version, [
    ...stillHere.map((accountId) => member(accountId, 'active', accountId === VIEWER ? { role: 'owner' } : {})),
    ...(gone.length ? [syncMember(STAND_IN, 'left', { display_name: 'Deleted account' })] : []),
  ], updatedAt);
}

const crewBefore = crewList(1, [], '2026-11-01T09:00:00Z');
// Each deletion sends its member list, then the messages it moved, each with that same list.
const mayaGone = { conversation: crewList(2, [MAYA], DELETED_AT), moved: syncMessage(6, CONVERSATION_ID, STAND_IN, 'From Maya') };
const adaGone = { conversation: crewList(3, [MAYA, ADA], '2026-11-18T10:00:01Z'), moved: syncMessage(7, CONVERSATION_ID, STAND_IN, 'From Ada') };
const adaFirst = { conversation: crewList(2, [ADA], DELETED_AT), moved: syncMessage(7, CONVERSATION_ID, STAND_IN, 'From Ada') };
const mayaSecond = { conversation: crewList(3, [MAYA, ADA], '2026-11-18T10:00:01Z'), moved: syncMessage(6, CONVERSATION_ID, STAND_IN, 'From Maya') };

/** One open web window that receives sync batches as the app does: lists first, then the rows. */
async function openCrewWindow(profiles: CloudPublicProfile[], loadedFromHistory = false) {
  const web = webWindow(profiles, [MAYA, ADA]);
  // A group loaded from history pages takes names from the member list and fetches no profiles.
  await applyMessage(web, syncMessage(1, CONVERSATION_ID, LEE, 'Saturday works'), crewBefore, loadedFromHistory);
  assert.deepEqual(groupTile(web.local), ['Ada Sample', 'Kim Sample', 'Lee Sample', 'Maya Sample', 'Me']);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: new EventTarget() });
  const unsubscribe = subscribeCloudGroupCatalog({
    accountId: VIEWER,
    hasSession: (sessionId) => Boolean(web.local?.sessions.some((session) => session.id === sessionId)),
    rememberConversations: () => undefined,
    applyRow: async () => undefined,
    reconcileMembers: async (conversation) => {
      await removeDepartedCloudGroupParticipants({
        conversation, viewerAccountId: VIEWER, getState: () => web.local,
        setState: (update) => web.setState(update), persistence: web.persistence,
      });
    },
    reportError: (error) => { throw error; },
  });
  const deliver = async (batch: Array<{ conversation: ChatSyncConversation; moved: ChatSyncMessage }>) => {
    const conversations = batch.flatMap(({ conversation }) => [conversation, conversation]);
    publishCloudGroupCatalog(VIEWER, conversations);
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const { conversation, moved } of batch) await applyMessage(web, moved, conversation);
  };
  const close = () => {
    unsubscribe();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  };
  return { web, deliver, close };
}

const everyone = () => [VIEWER, LEE, KIM, MAYA, ADA].filter((accountId) => accountId !== VIEWER).map((accountId) => profile(accountId, names[accountId]));
const remaining = ['Kim Sample', 'Lee Sample', 'Me'];

for (const [label, batches] of [
  ['one after the other', [[mayaGone], [adaGone]]],
  ['in the other order', [[adaFirst], [mayaSecond]]],
  ['in one sync batch', [[mayaGone, adaGone]]],
  ['newest list first', [[adaGone], [mayaGone]]],
] as const) {
  test(`two members deleted moments apart both leave an open group, ${label}`, () => withSession(async () => {
    const { web, deliver, close } = await openCrewWindow(everyone());
    try {
      for (const batch of batches) await deliver([...batch]);
      assert.deepEqual(groupTile(web.local), remaining);
      const left = web.store.participants.filter((row) => row.sessionId === GROUP && row.state !== 'active').map((row) => row.identityId).sort();
      assert.deepEqual(left, [`human:${ADA}`, `human:${MAYA}`]);
      assert.deepEqual(web.fetched, [], 'no profile is fetched for the deleted ids');
    } finally {
      close();
    }
  }));
}

test('a window that never loaded the deleted members asks for none of their profiles', () => withSession(async () => {
  const { web, deliver, close } = await openCrewWindow([profile(LEE, 'Lee Sample'), profile(KIM, 'Kim Sample')], true);
  try {
    assert.deepEqual(web.fetched, []);
    assert.equal(web.profileCache.has(MAYA) || web.profileCache.has(ADA), false);
    await deliver([mayaGone, adaGone]);
    assert.deepEqual(groupTile(web.local), remaining);
    assert.deepEqual(web.fetched, []);
  } finally {
    close();
  }
}));
