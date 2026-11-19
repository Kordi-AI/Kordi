import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyBrowserCanonicalCommand } from '@web/runtime/browserCanonicalCommands';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import type { CloudAuthClient, CloudPublicProfile, CloudSyncEvent } from '../src/features/cloud/authClient';
import { cloudMessageFromChatSync } from '../src/features/cloud/chatSyncMapping';
import type { ChatSyncConversation, ChatSyncMember, ChatSyncMessage } from '../src/features/cloud/chatSyncTypes';
import { buildCloudAuthError } from '../src/features/cloud/cloudAuthError';
import { applyCloudSyncEventsToMessagesByPeer } from '../src/features/cloud/cloudDiffSyncMessages';
import {
  mergeOpenCanonicalSessionFastResultIntoLocalState,
  upsertCanonicalIdentityIntoLocalState,
} from '../src/features/cloud/cloudCanonicalStateMerge';
import { browserGroupCanonicalPersistence } from '../src/features/cloud/cloudGroupCanonicalPersistence';
import { cloudGroupCatalogRow } from '../src/features/cloud/cloudGroupCatalog';
import { publishCloudGroupCatalog, subscribeCloudGroupCatalog } from '../src/features/cloud/cloudGroupCatalogSync';
import {
  cloudGroupDepartedParticipantIdentityIds,
  removeDepartedCloudGroupParticipants,
} from '../src/features/cloud/cloudGroupMemberReconciliation';
import { encodeCloudGroupControl, parseCloudGroupControl, type CloudGroupControlEnvelope } from '../src/features/cloud/cloudGroupMessages';
import { refreshCloudGroupProfiles } from '../src/features/cloud/cloudGroupProfileRefresh';
import { applyCloudGroupSessionControl } from '../src/features/cloud/cloudGroupSessionControl';
import {
  resolveAuthorizedCloudGroupSessionTitleSnapshot,
  resolveCloudGroupAdminSnapshot,
} from '../src/features/cloud/cloudGroupSessionPolicy';
import { cleanCloudText, cloudObjectContent } from '../src/features/cloud/cloudValue';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import type { CanonicalSessionState } from '../src/kordi-app/types';
import { STAND_IN, syncMember, syncMessage, VIEWER, viewerAccount } from './helpers/deletedAccountChatFixtures';

const GROUP = 'session:group:weekend';
const CONVERSATION_ID = '019d0000-0000-7000-8000-0000000000b1';
const LEE = 'acct_lee';
const KIM = 'acct_kim';
const MAYA = 'acct_maya';
const DELETED_AT = '2026-11-18T10:00:00Z';

function profile(accountId: string, displayName: string): CloudPublicProfile {
  return { accountId, displayName, avatarUrl: null, nodeId: null, isContact: true, isSelf: false };
}

const names: Record<string, string> = { [VIEWER]: 'Rowan Sample', [LEE]: 'Lee Sample', [KIM]: 'Kim Sample', [MAYA]: 'Maya Sample' };

function member(accountId: string, state: 'active' | 'left' = 'active', overrides: Partial<ChatSyncMember> = {}) {
  return syncMember(accountId, state, { display_name: names[accountId] ?? null, ...overrides });
}

function groupConversation(version: number, members: ChatSyncMember[], updatedAt: string): ChatSyncConversation {
  return {
    id: CONVERSATION_ID, kind: 'group', shared_title: null, version, created_by_account_id: VIEWER,
    legacy_session_id: GROUP, group_title: 'Weekend', latest_message_sequence: 4,
    created_at: '2026-11-01T09:00:00Z', updated_at: updatedAt, members, closed: null,
    preferences: { conversation_id: CONVERSATION_ID, account_id: VIEWER, personal_title: null, version: 1 },
  };
}

const beforeDeletion = groupConversation(1, [member(VIEWER, 'active', { role: 'owner' }), member(LEE), member(KIM), member(MAYA)], '2026-11-01T09:00:00Z');
// The deleted account's row is gone; the stand-in joined as a member who left.
const afterDeletion = groupConversation(2, [
  member(VIEWER, 'active', { role: 'owner' }), member(LEE), member(KIM),
  syncMember(STAND_IN, 'left', { display_name: 'Deleted account' }),
], DELETED_AT);

function emptyState(): CanonicalSessionState {
  return {
    storagePath: '/tmp/deleted-account-group.sqlite3',
    profile: {
      id: 'profile:rowan', displayName: 'Rowan Sample', humanIdentityId: `human:${VIEWER}`,
      activeAgentIdentityId: null, storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1,
    },
    identities: [], sessions: [], participants: [], messages: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
  } as CanonicalSessionState;
}

/** A web window: the browser store, the window's own copy of it, and what it has fetched. */
function webWindow(profiles: CloudPublicProfile[], missing: readonly string[] = [MAYA]) {
  const store = emptyState();
  const fetched: string[] = [];
  const window = {
    store,
    local: emptyState() as CanonicalSessionState | null,
    fetched,
    profileCache: new Map(profiles.map((entry) => [entry.accountId, entry])),
    persistence: browserGroupCanonicalPersistence(async (command, args) => (
      structuredClone(applyBrowserCanonicalCommand(store, command, args, 1_000)) as never
    )),
    client: {
      getProfile: async (_token: string, accountId: string) => {
        fetched.push(accountId);
        if (missing.includes(accountId)) {
          throw buildCloudAuthError(404, { error: { code: 'account_missing', message: 'No account found with that Kordi ID.' } }, 'Could not load profile.');
        }
        return profile(accountId, names[accountId] ?? accountId);
      },
    } as unknown as CloudAuthClient,
    setState(update: CanonicalSessionState | null | ((current: CanonicalSessionState | null) => CanonicalSessionState | null)) {
      window.local = typeof update === 'function' ? update(window.local) : update;
    },
  };
  return window;
}

type WebWindow = ReturnType<typeof webWindow>;

/** One live row through the real group pipeline, as a message event in an open window applies it. */
async function applyEnvelope(window: WebWindow, envelope: CloudGroupControlEnvelope, wire = {
  messageId: envelope.message?.id ?? 'wire', fromAccountId: envelope.actor.accountId, toAccountId: VIEWER, body: '',
  createdAt: DELETED_AT, deliveredAt: null, readAt: null, direction: 'incoming' as const, sessionId: GROUP,
}) {
  return applyCloudGroupSessionControl({
    persistence: window.persistence,
    cloudMessage: wire,
    envelope,
    runtime: { account: viewerAccount, client: window.client, profileCache: window.profileCache, sessionPreparationCache: new Map() },
    canonical: { getState: () => window.local, setState: (update) => window.setState(update) },
    stateOps: {
      objectContent: cloudObjectContent,
      cleanText: cleanCloudText,
      resolveAdminSnapshot: resolveCloudGroupAdminSnapshot,
      resolveSessionTitle: resolveAuthorizedCloudGroupSessionTitleSnapshot,
      upsertIdentity: upsertCanonicalIdentityIntoLocalState,
      mergeOpenSession: mergeOpenCanonicalSessionFastResultIntoLocalState,
    },
  });
}

async function applyMessage(window: WebWindow, message: ChatSyncMessage, conversation: ChatSyncConversation) {
  const wire = cloudMessageFromChatSync(message, conversation, VIEWER);
  const envelope = parseCloudGroupControl(wire.body);
  assert.ok(envelope, 'a group message becomes a group row');
  await applyEnvelope(window, envelope, wire);
  return envelope;
}

/** The members the group's sidebar tile draws, by name. */
function groupTile(state: CanonicalSessionState | null) {
  const conversations = createCanonicalSessionReadModel(state)?.buildChatConversations([], (_messages, fallback) => fallback ?? '') ?? [];
  const space = buildParticipantSpaces(conversations).find((candidate) => candidate.kind === 'group');
  assert.ok(space, 'the group is listed');
  return space.participants.filter((participant) => participant.kind === 'human').map((participant) => participant.name).sort();
}

function staleCopy(text: string, participants: string[]) {
  const person = (accountId: string) => ({ accountId, displayName: names[accountId] ?? accountId, avatarUrl: null, role: 'member' });
  return encodeCloudGroupControl({
    kind: 'group-message', groupId: GROUP, createdByAccountId: VIEWER, actor: person(LEE),
    participants: participants.map(person),
    message: { id: 'msg:stale-copy', senderAccountId: LEE, text, createdAtMs: 1, senderKind: 'human', senderDisplayName: 'Lee Sample' },
  } as CloudGroupControlEnvelope);
}

function withSession(run: () => Promise<void>) {
  __setSessionBackendForTests({
    load: async () => ({ token: 'rowan-token', accountId: VIEWER, expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => undefined,
    clear: async () => undefined,
  });
  return run().finally(() => __setSessionBackendForTests(null));
}

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

const STUDIO = { ...afterDeletion, shared_title: 'Studio plans', group_title: 'Studio' };

/** A catalog row as a window loads it: the session shell from the server's member list. */
async function loadCatalog(window: WebWindow, conversation: ChatSyncConversation) {
  const row = cloudGroupCatalogRow(conversation, VIEWER);
  assert.ok(row);
  await applyCloudGroupSessionControl({
    persistence: window.persistence, cloudMessage: row.wire, envelope: row.envelope, historyReplay: true,
    catalogGroupTitle: conversation.group_title, catalogGroupAvatar: conversation.group_avatar,
    runtime: { account: viewerAccount, client: window.client, profileCache: window.profileCache, sessionPreparationCache: new Map() },
    canonical: { getState: () => window.local, setState: (update) => window.setState(update) },
    stateOps: {
      objectContent: cloudObjectContent, cleanText: cleanCloudText,
      resolveAdminSnapshot: resolveCloudGroupAdminSnapshot, resolveSessionTitle: resolveAuthorizedCloudGroupSessionTitleSnapshot,
      upsertIdentity: upsertCanonicalIdentityIntoLocalState, mergeOpenSession: mergeOpenCanonicalSessionFastResultIntoLocalState,
    },
  });
}

function channel(state: CanonicalSessionState | null) {
  const session = state?.sessions.find((candidate) => candidate.id === GROUP);
  assert.ok(session);
  const metadata = session.metadata as Record<string, unknown>;
  const name = createCanonicalSessionReadModel(state)?.buildChatConversations([], (_messages, fallback) => fallback ?? '')
    .find((conversation) => conversation.canonicalSessionId === GROUP)?.name;
  return { name, creator: session.createdByIdentityId, admins: metadata.adminIdentityIds as string[] };
}

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
