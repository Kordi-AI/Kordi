import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { ACCOUNT_HINT_EVENT_TYPES } from '../src/features/cloud/accountHintEvents';
import type { GroupGroundingPerson } from '../src/features/commonGround/groupPeople';
import { normalizeGroupGroundingPeople } from '../src/features/commonGround/groupPeople';
import type { CgHost } from '../src/features/commonGround/host';
import { InviteToGroupDialog } from '../src/features/commonGround/InviteToGroupDialog';
import { PersonActions } from '../src/features/commonGround/PersonActions';
import { notifyCommonGroundRoomEvents, subscribeInvitationHints, subscribeRoomHints } from '../src/features/commonGround/roomHints';
import { answerPath, createRoomInvitationsStore, normalizeRoomInvitation } from '../src/features/commonGround/roomInvitations';
import { CommonGroundStore } from '../src/features/commonGround/store';
import type { CgInviteGroup, CgPersonGroups } from '../src/features/commonGround/types';
import { ContactsRoomInvitationDetail } from '../src/kordi-app/contacts/ContactsRoomInvitationDetail';
import { addPeopleButtonLabel } from '../src/pages/groupGroundingPeople';
import { GroupDetailsDialog } from '../src/pages/GroupDetailsDialog';
import { mockServer, person, rel } from './helpers/commonGroundServer';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';
import { contact, conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';

// Inviting Grounding people into groups: the person-page picker, Group › Add people's
// "From Grounding" section, and the invitee's person invitations in Contacts › Requests.

const chen = { ...person('acct_chen', rel()), name: 'Chen Wei' };
const group = (id: string, patch: Partial<CgInviteGroup> = {}): CgInviteGroup => ({
  groupSpaceId: `session:group:${id}`, conversationId: `conv_${id}`, name: 'Infrastructure and CI', memberCount: 3,
  members: [person('acct_alex'), person('acct_bea'), person('acct_sam')], state: null, ...patch,
});

// Invitee side

const personInvitation = (ref: string, patch: Record<string, unknown> = {}) => ({
  kind: 'group', invitationRef: ref, code: null, roomName: null, groupSpaceId: `session:group:${ref}`, conversationId: `conv_${ref}`,
  name: 'Infrastructure and CI', from: { accountId: 'acct_alex', name: 'Alex Rivera', avatarUrl: null },
  members: [{ accountId: 'acct_alex', name: 'Alex Rivera', avatarUrl: null }], memberCount: 3, createdAt: '2026-11-13T10:00:00Z', ...patch,
});

test('a person invitation without a code is kept; a room invitation still needs its code', () => {
  const invitation = normalizeRoomInvitation(personInvitation('inv_1'));
  assert.ok(invitation);
  assert.equal(invitation.kind, 'group');
  assert.equal(invitation.code, null);
  assert.equal(invitation.roomName, '');
  assert.equal(normalizeRoomInvitation({ ...personInvitation('inv_2'), kind: 'room' }), null);
  const room = normalizeRoomInvitation({ ...personInvitation('inv_3'), kind: undefined, code: '4821', roomName: 'Build night' });
  assert.equal(room?.kind, 'room');
});

test('person invitations answer through the group invitation routes, room ones through their room', async () => {
  const group = normalizeRoomInvitation(personInvitation('inv_1'));
  const room = normalizeRoomInvitation(personInvitation('cgi_2', { kind: 'room', code: '4821', roomName: 'Build night' }));
  assert.ok(group && room);
  assert.equal(answerPath(group, 'join'), '/v1/cloud/common-ground/group-invitations/inv_1/join');
  assert.equal(answerPath(room, 'decline'), '/v1/cloud/common-ground/rooms/4821/invitations/cgi_2/decline');

  const calls: string[] = [];
  const replies: unknown[] = [
    { invitations: [personInvitation('inv_1'), personInvitation('inv_2')] },
    { status: 'joined', groupSpaceId: 'session:group:inv_1' }, { invitations: [personInvitation('inv_2')] },
    null, { invitations: [] },
  ];
  const store = createRoomInvitationsStore({
    token: async () => ({ token: 'tok', accountId: 'acct_chen' }),
    request: async <T,>(path: string, init: RequestInit) => {
      if (init.method === 'POST') calls.push(path);
      return replies.shift() as T;
    },
  });
  await store.refresh();
  const [first, second] = store.getSnapshot().invitations;
  assert.deepEqual(await store.join(first), { ok: true, groupSpaceId: 'session:group:inv_1' });
  assert.equal((await store.decline(second)).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [
    '/v1/cloud/common-ground/group-invitations/inv_1/join',
    '/v1/cloud/common-ground/group-invitations/inv_2/decline',
  ]);
});

test('the invitation detail says "from Grounding" when no room is shared', () => {
  const invitation = normalizeRoomInvitation(personInvitation('inv_1'));
  assert.ok(invitation);
  const noop = { join: async () => ({ ok: true as const, groupSpaceId: '' }), decline: async () => ({ ok: true as const, groupSpaceId: '' }), select: () => undefined };
  const markup = renderToStaticMarkup(createElement(ContactsRoomInvitationDetail, { invitation, state: { busyRef: null, error: null, outcome: null }, store: noop }));
  assert.match(markup, /Alex Rivera · from Grounding/);
  const fromRoom = normalizeRoomInvitation(personInvitation('inv_2', { roomName: 'Build night' }));
  assert.ok(fromRoom);
  assert.match(renderToStaticMarkup(createElement(ContactsRoomInvitationDetail, { invitation: fromRoom, state: { busyRef: null, error: null, outcome: null }, store: noop })), /Alex Rivera · from Build night/);
});

test('the invitations hint is an account hint and reaches invitation listeners only', () => {
  assert.ok(ACCOUNT_HINT_EVENT_TYPES.has('common_ground.invitations.updated'));
  let invitations = 0;
  let rooms = 0;
  const stopInvitations = subscribeInvitationHints(() => { invitations += 1; });
  const stopRooms = subscribeRoomHints(() => { rooms += 1; });
  notifyCommonGroundRoomEvents([{ eventType: 'common_ground.invitations.updated', payload: {} }, { eventType: 'common_ground.invitations.updated', payload: {} }]);
  stopInvitations();
  stopRooms();
  assert.equal(invitations, 1);
  assert.equal(rooms, 0);
});

// Person page

const host: CgHost = {
  self: { accountId: 'acct_alex', name: 'Alex Rivera', avatarUrl: null }, profiles: true, memoryAvailable: false, connectors: null, agentFiles: null, device: null,
  openChat: () => undefined, acceptRequest: async () => undefined, contactsChanged: () => undefined, openGroup: () => undefined, openUrl: () => undefined,
};

function dialog(picker: CgPersonGroups | null | undefined, loading = false) {
  return renderToStaticMarkup(createElement(InviteToGroupDialog, {
    person: chen, picker, loading, busy: false, notice: null, onCancel: () => undefined, onInvite: () => undefined,
  }));
}

test('the person page shows Invite after Add, Meet and Chat', () => {
  const store = new CommonGroundStore(mockServer({}).client);
  const markup = renderToStaticMarkup(createElement(PersonActions, { person: chen, state: store.getSnapshot(), store, host }));
  const labels = [...markup.matchAll(/<span class="inline-flex items-center gap-1">([^<]+)<\/span>/g)].map((match) => match[1]);
  assert.deepEqual(labels, ['Add', 'Meet', 'Chat', 'Invite']);
  store.set({ support: { ...store.getSnapshot().support, groupInvite: false } });
  assert.doesNotMatch(renderToStaticMarkup(createElement(PersonActions, { person: chen, state: store.getSnapshot(), store, host })), />Invite</);
});

test('the picker names the person, marks Member and Invited groups, and says Add for a contact', () => {
  const markup = dialog({ contact: false, groups: [group('a'), group('b', { name: 'Hackathon team', state: 'member' }), group('c', { name: 'Reading group', state: 'invited', memberCount: 1 })] });
  assert.match(markup, /Invite Chen to a group/);
  assert.match(markup, />3 members</);
  assert.match(markup, />1 member</);
  assert.match(markup, /disabled=""[^>]*>[\s\S]*?Hackathon team[\s\S]*?>Member</);
  assert.match(markup, />Invited</);
  assert.match(markup, />Invite<\/button>/);
  assert.match(dialog({ contact: true, groups: [group('a')] }), />Add<\/button>/);
  assert.match(dialog({ contact: false, groups: [] }), />No groups you can invite to</);
  assert.match(dialog(null), />No groups you can invite to</);
  assert.match(dialog(undefined, true), /Loading groups/);
});

test('the picker loads the person groups and sends one account id, confirming Invited or Added', async () => {
  const server = mockServer({
    'GET people/acct_chen/groups': { status: 200, body: { contact: false, groups: [group('a'), { groupSpaceId: 'session:group:b', name: 'Hackathon team', memberCount: 2, members: [], state: 'member' }] } },
    'POST group-invitations': [
      { status: 200, body: { invited: [chen], added: [], skipped: [] } },
      { status: 200, body: { invited: [], added: [chen], skipped: [] } },
      { status: 200, body: { invited: [], added: [], skipped: [{ accountId: 'acct_chen', reason: 'declined' }] } },
    ],
  });
  const store = new CommonGroundStore(server.client);
  await store.loadInviteGroups('acct_chen');
  const picker = store.getSnapshot().inviteGroups.acct_chen;
  assert.ok(picker);
  assert.deepEqual(picker.groups.map((entry) => entry.state), [null, 'member']);
  assert.equal(await store.inviteToGroup(chen, picker.groups[0]), 'Invited Chen to Infrastructure and CI');
  assert.equal(store.getSnapshot().inviteGroups.acct_chen?.groups[0].state, 'invited');
  assert.deepEqual(server.calls.at(-1)?.body, { groupSpaceId: 'session:group:a', accountIds: ['acct_chen'] });
  assert.equal(await store.inviteToGroup(chen, picker.groups[0]), 'Added Chen to Infrastructure and CI');
  assert.equal(await store.inviteToGroup(chen, picker.groups[0]), null);
  assert.equal(store.getSnapshot().notice, "Chen can't be invited to Infrastructure and CI.");
});

test('a person who cannot be invited lists no groups; an older server turns Invite off', async () => {
  const gone = mockServer({ 'GET people/acct_chen/groups': { status: 404, body: { errorCode: 'common_ground_person_not_found', message: 'Not found.' } } });
  const store = new CommonGroundStore(gone.client);
  await store.loadInviteGroups('acct_chen');
  assert.equal(store.getSnapshot().inviteGroups.acct_chen, null);
  assert.equal(store.getSnapshot().notice, null);
  assert.equal(store.getSnapshot().support.groupInvite, true);

  const older = new CommonGroundStore(mockServer({}).client);
  await older.loadInviteGroups('acct_chen');
  assert.equal(older.getSnapshot().support.groupInvite, false);
});

// Group › Add people

test('the Add people button names adds and invites', () => {
  assert.equal(addPeopleButtonLabel(0, 0), 'Select people to add');
  assert.equal(addPeopleButtonLabel(1, 0), 'Add 1 person');
  assert.equal(addPeopleButtonLabel(2, 0), 'Add 2 people');
  assert.equal(addPeopleButtonLabel(0, 1), 'Invite 1 person');
  assert.equal(addPeopleButtonLabel(0, 3), 'Invite 3 people');
  assert.equal(addPeopleButtonLabel(2, 1), 'Add 2, invite 1');
});

test('group people decode with "Match" left to the view, and malformed rows are skipped', () => {
  const people = normalizeGroupGroundingPeople({ people: [
    { person: { accountId: 'acct_chen', name: 'Chen Wei', handle: 'chenwei', avatarUrl: null }, source: 'Build night', invited: false },
    { person: {}, source: null, invited: false },
    { person: { accountId: 'acct_ines', name: 'Ines Faure' }, source: null, invited: true },
  ] });
  assert.deepEqual(people.map((entry) => [entry.accountId, entry.source, entry.invited]), [['acct_chen', 'Build night', false], ['acct_ines', null, true]]);
  assert.deepEqual(normalizeGroupGroundingPeople(null), []);
});

function groupSpace() {
  const [space] = buildParticipantSpaces([conversation({
    id: 'session:group:infra',
    canonicalSessionId: 'session:group:infra',
    name: 'Infrastructure and CI',
    metadata: { adminIdentityIds: ['human:me'], groupSpaceId: 'session:group:infra', customName: 'Infrastructure and CI' },
    participants: ['Me', 'Bea Okafor', 'Sam Park'],
    canonicalParticipants: [
      { id: 'human:me', humanId: 'acct_alex', name: 'Me', kind: 'human', role: 'self', source: 'cloud', avatarKey: 'me' },
      { id: 'human:bea', humanId: 'acct_bea', name: 'Bea Okafor', kind: 'human', role: 'person', source: 'cloud', avatarKey: 'bea' },
      { id: 'human:sam', humanId: 'acct_sam', name: 'Sam Park', kind: 'human', role: 'person', source: 'cloud', avatarKey: 'sam' },
    ],
  })]);
  return space;
}

const dana = contact({ id: 'cloud:acct_dana', name: 'Dana Kim', sourceParticipantId: 'acct_dana', sourceHumanId: 'acct_dana', subtitle: '@dana', detail: '@dana', contactStatus: 'accepted' });
const groundingPeople: GroupGroundingPerson[] = [
  { accountId: 'acct_chen', name: 'Chen Wei', handle: 'chenwei', avatarUrl: null, source: 'Build night', invited: false },
  { accountId: 'acct_lee', name: 'Lee Moreau', handle: null, avatarUrl: null, source: 'Build night', invited: true },
  { accountId: 'acct_ines', name: 'Ines Faure', handle: null, avatarUrl: null, source: null, invited: false },
];

async function openAddPeople(props: Record<string, unknown>) {
  const addTile = document.querySelector<HTMLButtonElement>('[data-group-member-grid] button[aria-label="Add people"]');
  assert.ok(addTile, JSON.stringify(Object.keys(props)));
  await act(async () => { addTile.click(); });
  await waitForReactCondition(() => Boolean(document.querySelector('[aria-label="Contacts available to add"]')), 'Add people opens');
}

const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim().startsWith(text));

test('Add people lists Contacts, then From Grounding, and splits adds from invitations', async () => {
  await withJsdomRoot(async (mount) => {
    Object.assign(window.HTMLElement.prototype, { attachEvent: () => {}, detachEvent: () => {} });
    const listed: string[] = [];
    const added: string[][] = [];
    const invited: Array<[string, string[]]> = [];
    const props = {
      isOpen: true, space: groupSpace(), contacts: [dana], onClose: () => {}, onRename: () => {}, onRemoveMember: () => {}, onSetAdmin: () => {},
      onAddMembers: (_sessionIds: string[], contactIds: string[]) => { added.push(contactIds); },
      onListGroundingPeople: async (groupSpaceId: string) => { listed.push(groupSpaceId); return groundingPeople; },
      onInviteGroundingPeople: async (groupSpaceId: string, accountIds: string[]) => { invited.push([groupSpaceId, accountIds]); },
    };
    const host = await mount(createElement(GroupDetailsDialog, props));
    assert.deepEqual(listed, [], 'nothing loads before Add people opens');
    await openAddPeople(props);
    await waitForReactCondition(() => Boolean(host.querySelector('[aria-label="People from Grounding"]')), 'Grounding people load');
    assert.deepEqual(listed, ['session:group:infra']);

    const text = host.textContent ?? '';
    assert.match(text, /People/);
    assert.doesNotMatch(text, /Existing contacts/);
    assert.equal(host.querySelector<HTMLInputElement>('input[type="search"][placeholder="Search people"]')?.placeholder, 'Search people');
    assert.ok(text.indexOf('Contacts') < text.indexOf('From Grounding'));
    const groundingRows = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="People from Grounding"] button')];
    assert.deepEqual(groundingRows.map((row) => row.textContent), ['Chen WeiBuild night', 'Lee MoreauBuild nightInvited', 'Ines FaureMatch']);
    assert.equal(groundingRows[1].disabled, true);

    await act(async () => { button('Chen Wei')?.click(); });
    assert.ok(button('Invite 1 person'));
    await act(async () => { button('Dana Kim')?.click(); });
    const submit = button('Add 1, invite 1');
    assert.ok(submit);
    await act(async () => { submit.click(); });
    await waitForReactCondition(() => !host.querySelector('[aria-label="People from Grounding"]'), 'Add people closes');
    assert.deepEqual(added, [['cloud:acct_dana']]);
    assert.deepEqual(invited, [['session:group:infra', ['acct_chen']]]);
  });
});

test('search filters both sections, and a failed Grounding list hides its section', async () => {
  await withJsdomRoot(async (mount) => {
    Object.assign(window.HTMLElement.prototype, { attachEvent: () => {}, detachEvent: () => {} });
    const base = { isOpen: true, space: groupSpace(), contacts: [dana], onClose: () => {}, onRename: () => {}, onRemoveMember: () => {}, onSetAdmin: () => {}, onAddMembers: () => {} };
    const host = await mount(createElement(GroupDetailsDialog, { ...base, onListGroundingPeople: async () => groundingPeople }));
    await openAddPeople(base);
    await waitForReactCondition(() => Boolean(host.querySelector('[aria-label="People from Grounding"]')), 'Grounding people load');
    const search = host.querySelector<HTMLInputElement>('input[placeholder="Search people"]');
    assert.ok(search);
    await act(async () => {
      search.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, 'ines');
      search.dispatchEvent(new window.Event('input', { bubbles: true }));
      // react-dom loaded before jsdom, so it reads changes on key events.
      search.dispatchEvent(new window.KeyboardEvent('keyup', { bubbles: true }));
    });
    await waitForReactCondition(() => host.querySelectorAll('[aria-label="People from Grounding"] button').length === 1, 'search filters Grounding');
    assert.match(host.textContent ?? '', /No contacts match/);
  });
  await withJsdomRoot(async (mount) => {
    Object.assign(window.HTMLElement.prototype, { attachEvent: () => {}, detachEvent: () => {} });
    const base = { isOpen: true, space: groupSpace(), contacts: [dana], onClose: () => {}, onRename: () => {}, onRemoveMember: () => {}, onSetAdmin: () => {}, onAddMembers: () => {} };
    const host = await mount(createElement(GroupDetailsDialog, { ...base, onListGroundingPeople: async () => { throw new Error('Not found'); } }));
    await openAddPeople(base);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(host.querySelector('[aria-label="People from Grounding"]'), null);
    assert.doesNotMatch(host.textContent ?? '', /From Grounding/);
    assert.ok(button('Dana Kim'));
  });
});
