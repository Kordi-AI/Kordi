import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import { createRoomInvitationsStore, normalizeRoomInvitation } from '../src/features/commonGround/roomInvitations';
import { notifyCommonGroundRoomEvents, subscribeRoomHints } from '../src/features/commonGround/roomHints';
import { ContactsRoomInvitationRow } from '../src/kordi-app/contacts/ContactsRoomInvitationRow';
import { COMMON_GROUND_ROOM_FOCUS_EVENT, hasPendingRoomFocus, rememberRoomFocus, takePendingRoomFocus } from '../src/features/commonGround/roomFocus';
import { ResultsScreen } from '../src/features/commonGround/ResultsScreen';
import { CommonGroundStore } from '../src/features/commonGround/store';
import type { CgHost } from '../src/features/commonGround/host';
import { commonGroundFixtures } from './visual/commonGroundFixtures';
import { mockServer, person, room } from './helpers/commonGroundServer';

const wire = (ref: string, patch: Record<string, unknown> = {}) => ({
  invitationRef: ref, code: '4821', roomName: 'Build night', groupSpaceId: `session:group:${ref}`, conversationId: `conv_${ref}`,
  name: 'Infrastructure and CI', from: { accountId: 'acct_alex', name: 'Alex Rivera', avatarUrl: null }, createdAt: '2026-11-13T10:00:00Z', ...patch,
});

function transport(replies: Array<unknown | Error>, account = 'acct_dana') {
  const calls: Array<{ path: string; method: string }> = [];
  let session: { token: string; accountId: string } | null = { token: 'tok', accountId: account };
  return {
    calls,
    signOut: () => { session = null; },
    switchTo: (accountId: string) => { session = { token: 'tok2', accountId }; },
    transport: {
      token: async () => session,
      request: async <T,>(path: string, init: RequestInit) => {
        calls.push({ path, method: init.method ?? 'GET' });
        const reply = replies.length > 1 ? replies.shift() : replies[0];
        if (reply instanceof Error) throw reply;
        return reply as T;
      },
    },
  };
}

test('pending room invitations load, skip malformed rows, and clear on sign-out', async () => {
  const fake = transport([{ invitations: [wire('cgi_1'), { invitationRef: 'broken' }, wire('cgi_2')] }]);
  const store = createRoomInvitationsStore(fake.transport);
  await store.refresh();
  assert.deepEqual(store.getSnapshot().invitations.map((row) => row.invitationRef), ['cgi_1', 'cgi_2']);
  assert.equal(fake.calls[0].path, '/v1/cloud/common-ground/invitations');
  fake.signOut();
  await store.refresh();
  assert.deepEqual(store.getSnapshot().invitations, []);
});

test('an older server without the route lists nothing; other failures keep the list', async () => {
  const fake = transport([{ invitations: [wire('cgi_1')] }, new Error('offline'), new CloudAuthError('not_found', 'Not found', 404)]);
  const store = createRoomInvitationsStore(fake.transport);
  await store.refresh();
  await store.refresh();
  assert.equal(store.getSnapshot().invitations.length, 1);
  await store.refresh();
  assert.equal(store.getSnapshot().invitations.length, 0);
});

test('joining and declining call the room invitation routes and drop the row', async () => {
  const fake = transport([
    { invitations: [wire('cgi_1'), wire('cgi_2')] },
    { status: 'joined', groupSpaceId: 'session:group:cgi_1', conversationId: 'conv_cgi_1' },
    { invitations: [wire('cgi_2')] },
    null,
    { invitations: [] },
  ]);
  const store = createRoomInvitationsStore(fake.transport);
  await store.refresh();
  const [first, second] = store.getSnapshot().invitations;
  const joined = await store.join(first);
  assert.deepEqual(joined, { ok: true, groupSpaceId: 'session:group:cgi_1' });
  assert.equal(await store.decline(second).then((result) => result.ok), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const posts = fake.calls.filter((call) => call.method === 'POST').map((call) => call.path);
  assert.deepEqual(posts, [
    '/v1/cloud/common-ground/rooms/4821/invitations/cgi_1/join',
    '/v1/cloud/common-ground/rooms/4821/invitations/cgi_2/decline',
  ]);
  assert.deepEqual(store.getSnapshot().invitations, []);
});

test('a failed answer keeps the row and shows the server message; a gone invitation is dropped', async () => {
  const fake = transport([
    { invitations: [wire('cgi_1'), wire('cgi_2')] },
    new CloudAuthError('group_invitation_full', 'This group already has the maximum number of members.', 409),
    { invitations: [wire('cgi_1'), wire('cgi_2')] },
    new CloudAuthError('common_ground_invitation_not_found', 'Invitation not found.', 404),
    { invitations: [wire('cgi_1')] },
  ]);
  const store = createRoomInvitationsStore(fake.transport);
  await store.refresh();
  const [first, second] = store.getSnapshot().invitations;
  assert.equal((await store.join(first)).ok, false);
  assert.equal(store.getSnapshot().error, 'This group already has the maximum number of members.');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.getSnapshot().invitations.length, 2);
  assert.equal((await store.decline(second)).ok, false);
  assert.deepEqual(store.getSnapshot().invitations.map((row) => row.invitationRef), ['cgi_1']);
});

test('a Grounding room hint reaches room hint listeners, which refresh the invitations', () => {
  let seen = 0;
  const unsubscribe = subscribeRoomHints(() => { seen += 1; });
  notifyCommonGroundRoomEvents([{ eventType: 'common_ground.room.updated', payload: { code: '4821' } }]);
  unsubscribe();
  assert.equal(seen, 1);
});

test('the Requests row names the inviter and group and resolves kordi-avatar markers', () => {
  const invitation = normalizeRoomInvitation(wire('cgi_1', {
    from: { accountId: 'acct_alex', name: 'Alex Rivera', avatarUrl: 'kordi-avatar://dicebear-rust-10.6.0-styles-10.5.0/lorelei/alex_seed?version=1' },
  }));
  assert.ok(invitation);
  const markup = renderToStaticMarkup(createElement(ContactsRoomInvitationRow, { invitation, busy: false, onJoin: () => undefined, onDecline: () => undefined }));
  assert.match(markup, /Alex Rivera invited you/);
  assert.match(markup, />Infrastructure and CI</);
  assert.match(markup, /aria-label="Open Infrastructure and CI"/);
  assert.match(markup, />Join</);
  assert.match(markup, />Decline</);
  assert.doesNotMatch(markup, /src="kordi-avatar:/);
  assert.match(markup, /boring-marble-v1\/alex_seed\.png/);
});

test('opening an invitation keeps the room and group until the Grounding page takes them', () => {
  const target = new EventTarget();
  let announced: unknown = null;
  target.addEventListener(COMMON_GROUND_ROOM_FOCUS_EVENT, (event) => { announced = (event as CustomEvent).detail; });
  rememberRoomFocus({ code: '4821', groupSpaceId: 'session:group:cgi_1' }, target);
  assert.deepEqual(announced, { code: '4821', groupSpaceId: 'session:group:cgi_1' });
  assert.equal(hasPendingRoomFocus(), true);
  assert.deepEqual(takePendingRoomFocus(), { code: '4821', groupSpaceId: 'session:group:cgi_1' });
  assert.equal(takePendingRoomFocus(), null);
});

test('the room opens on the invited group, with its group and invitation rows focused', async () => {
  const fx = commonGroundFixtures('light');
  const group = { groupSpaceId: 'session:group:cgi_1', conversationId: 'conv_1', name: 'Infrastructure and CI', memberCount: 2, members: [person('acct_alex')], joined: false };
  const other = { ...group, groupSpaceId: 'session:group:other', name: 'Other group' };
  const invitation = { invitationRef: 'cgi_1', groupSpaceId: group.groupSpaceId, name: group.name, from: { ...person('acct_alex'), name: 'Alex Rivera' }, createdAt: '2026-11-13T10:00:00Z' };
  const server = mockServer({ 'POST rooms/4821/results': { status: 200, body: { ...fx.results, groups: [other, group], invitations: [invitation] } } });
  const store = new CommonGroundStore(server.client, { profiles: true });
  store.set({ rooms: { '4821': room('4821') } });
  store.openRoom('4821', group.groupSpaceId);
  assert.deepEqual(store.top(), { name: 'results', code: '4821', focusGroup: group.groupSpaceId });
  await store.loadScreen({ name: 'results', code: '4821' });
  const host: CgHost = {
    self: fx.self, profiles: true, memoryAvailable: false, connectors: null, agentFiles: null, device: null,
    openChat: () => undefined, acceptRequest: async () => undefined, contactsChanged: () => undefined,
    openGroup: () => undefined, openUrl: () => undefined,
  };
  const markup = renderToStaticMarkup(createElement(ResultsScreen, { code: '4821', focusGroup: group.groupSpaceId, state: store.getSnapshot(), store, host }));
  assert.equal((markup.match(/is-focused/g) ?? []).length, 2);
  assert.match(markup, /Alex Rivera invited you to Infrastructure and CI/);
  const plain = renderToStaticMarkup(createElement(ResultsScreen, { code: '4821', state: store.getSnapshot(), store, host }));
  assert.doesNotMatch(plain, /is-focused/);
});
