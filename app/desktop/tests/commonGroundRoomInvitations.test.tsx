import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import { createRoomInvitationsStore, normalizeRoomInvitation } from '../src/features/commonGround/roomInvitations';
import { notifyCommonGroundRoomEvents, subscribeRoomHints } from '../src/features/commonGround/roomHints';
import { ContactsRoomInvitationRow } from '../src/kordi-app/contacts/ContactsRoomInvitationRow';
import { ContactsRoomInvitationDetail } from '../src/kordi-app/contacts/ContactsRoomInvitationDetail';

const wire = (ref: string, patch: Record<string, unknown> = {}) => ({
  invitationRef: ref, code: '4821', roomName: 'Build night', groupSpaceId: `session:group:${ref}`, conversationId: `conv_${ref}`,
  name: 'Infrastructure and CI', from: { accountId: 'acct_alex', name: 'Alex Rivera', avatarUrl: null }, createdAt: '2026-11-13T10:00:00Z',
  members: [{ accountId: 'acct_alex', name: 'Alex Rivera', avatarUrl: null }, { accountId: 'acct_bea', name: 'Bea Okafor', avatarUrl: null }], memberCount: 2, ...patch,
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

test('the Requests row shows the inviter over the group, with labelled Decline and Join icons', () => {
  const invitation = normalizeRoomInvitation(wire('cgi_1', {
    from: { accountId: 'acct_alex', name: 'Alex Rivera', avatarUrl: 'kordi-avatar://dicebear-rust-10.6.0-styles-10.5.0/lorelei/alex_seed?version=1' },
  }));
  assert.ok(invitation);
  const calls: string[] = [];
  const markup = renderToStaticMarkup(createElement(ContactsRoomInvitationRow, {
    invitation, active: true, busy: false, onOpen: () => calls.push('open'), onJoin: () => undefined, onDecline: () => undefined,
  }));
  assert.match(markup, />Alex Rivera</);
  assert.match(markup, /Invited you to Infrastructure and CI/);
  assert.match(markup, /aria-label="Decline" title="Decline"/);
  assert.match(markup, /aria-label="Join" title="Join"/);
  assert.match(markup, /app-contact-row-selected/);
  assert.match(markup, /aria-current="true"/);
  assert.doesNotMatch(markup, /src="kordi-avatar:/);
  assert.match(markup, /boring-marble-v1\/alex_seed\.png/);
});

test('members decode from the list, and an older server without them lists none', () => {
  const invitation = normalizeRoomInvitation(wire('cgi_1'));
  assert.ok(invitation);
  assert.deepEqual(invitation.members.map((member) => member.name), ['Alex Rivera', 'Bea Okafor']);
  assert.equal(invitation.memberCount, 2);
  const older = normalizeRoomInvitation(wire('cgi_2', { members: undefined, memberCount: undefined }));
  assert.ok(older);
  assert.deepEqual(older.members, []);
  assert.equal(older.memberCount, 0);
});

const noop = { join: async () => ({ ok: true as const, groupSpaceId: '' }), decline: async () => ({ ok: true as const, groupSpaceId: '' }), select: () => undefined };

test('the invitation detail leads with the group, then who invited you, Decline and Join, and the members', () => {
  const invitation = normalizeRoomInvitation(wire('cgi_1'));
  assert.ok(invitation);
  const markup = renderToStaticMarkup(createElement(ContactsRoomInvitationDetail, { invitation, state: { busyRef: null, error: null, outcome: null }, store: noop }));
  assert.match(markup, /aria-label="Invitation to Infrastructure and CI"/);
  assert.match(markup, />Infrastructure and CI</);
  assert.match(markup, /Alex Rivera · from Build night/);
  assert.match(markup, />Decline</);
  assert.match(markup, />Join</);
  assert.match(markup, />Members</);
  assert.match(markup, />Bea Okafor</);
  assert.doesNotMatch(markup, /topic|Share code|Suggested/i);
});

test('after an answer the detail shows one line instead of the buttons', () => {
  const invitation = normalizeRoomInvitation(wire('cgi_1'));
  assert.ok(invitation);
  const joined = renderToStaticMarkup(createElement(ContactsRoomInvitationDetail, { invitation, state: { busyRef: null, error: null, outcome: 'joined' }, store: noop }));
  assert.match(joined, /You joined Infrastructure and CI\./);
  assert.doesNotMatch(joined, />Join</);
  const declined = renderToStaticMarkup(createElement(ContactsRoomInvitationDetail, { invitation, state: { busyRef: null, error: null, outcome: 'declined' }, store: noop }));
  assert.match(declined, />Declined</);
});

test('selecting an invitation keeps it open after answering, with the outcome', async () => {
  const fake = transport([
    { invitations: [wire('cgi_1')] },
    { status: 'joined', groupSpaceId: 'session:group:cgi_1' },
    { invitations: [] },
  ]);
  const store = createRoomInvitationsStore(fake.transport);
  await store.refresh();
  const [invitation] = store.getSnapshot().invitations;
  store.select(invitation);
  assert.equal(store.getSnapshot().selected?.invitationRef, 'cgi_1');
  await store.join(invitation);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.getSnapshot().selected?.invitationRef, 'cgi_1');
  assert.equal(store.getSnapshot().outcome, 'joined');
  assert.deepEqual(store.getSnapshot().invitations, []);
  store.select(null);
  assert.equal(store.getSnapshot().selected, null);
  assert.equal(store.getSnapshot().outcome, null);
});

test('an invitation opened from Requests takes the Contacts main pane until it is closed', async () => {
  const { renderContactsPage } = await import('./helpers/contactsPageFixtures');
  const { roomInvitationsStore } = await import('../src/features/commonGround/roomInvitations');
  const invitation = normalizeRoomInvitation(wire('cgi_1'));
  assert.ok(invitation);
  const store = roomInvitationsStore();
  store.select(invitation);
  try {
    const markup = renderContactsPage([]);
    assert.match(markup, /aria-label="Invitation to Infrastructure and CI"/);
    assert.doesNotMatch(markup, /No contact selected/);
  } finally {
    store.select(null);
  }
  assert.doesNotMatch(renderContactsPage([]), /Invitation to Infrastructure and CI/);
});
