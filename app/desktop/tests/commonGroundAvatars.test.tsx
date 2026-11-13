import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CgAvatar, CgAvatarGrid, CgSignedInAccount } from '../src/features/commonGround/parts';
import { ResultsScreen } from '../src/features/commonGround/ResultsScreen';
import { CommonGroundStore } from '../src/features/commonGround/store';
import type { CgHost } from '../src/features/commonGround/host';
import { canonicalAvatarImageUrl } from '../src/features/cloud/canonicalAvatar';
import { commonGroundFixtures, generatedPersonAvatar } from './visual/commonGroundFixtures';
import { mockServer, owner, person, room } from './helpers/commonGroundServer';
import { mount } from './helpers/nearbyScreen';

test('Grounding people use current seeded human presentation and preserve supplied uploads', () => {
  const generated = renderToStaticMarkup(createElement(CgAvatar, { person: person('acct_hana'), size: 64 }));
  assert.match(generated, /preview\/boring-marble-v1\/acct_hana\.png/);
  const uploaded = renderToStaticMarkup(createElement(CgAvatar, {
    person: { ...person('acct_hana'), avatarUrl: 'https://images.example.test/hana.png' }, size: 64,
  }));
  assert.match(uploaded, /https:\/\/images.example.test\/hana\.png/);
  assert.doesNotMatch(uploaded, /boring-marble-v1/);
  const regenerated = renderToStaticMarkup(createElement(CgAvatar, {
    person: { ...person('acct_hana'), avatarUrl: generatedPersonAvatar('hana_new_seed') }, size: 64,
  }));
  assert.match(regenerated, /boring-marble-v1\/hana_new_seed\.png/);
});

test('room collages use the shared square avatar with at most nine square member tiles', () => {
  const people = Array.from({ length: 12 }, (_, index) => person(`acct_member_${index}`));
  const markup = renderToStaticMarkup(createElement(CgAvatarGrid, { people, size: 72 }));
  assert.match(markup, /app-group-avatar/);
  assert.match(markup, /rounded-\[17%\]/);
  assert.equal((markup.match(/min-h-0 min-w-0/g) ?? []).length, 9);
  assert.doesNotMatch(markup, /border-radius:50%/);
  assert.match(renderToStaticMarkup(createElement(CgAvatarGrid, { people: [], size: 30 })), /app-group-avatar/);
});

test('results show both populated and empty groups as square group avatars', async () => {
  const fx = commonGroundFixtures('light');
  const response = { ...fx.results, groups: [
    { groupSpaceId: 'group_full', name: 'Memory group', memberCount: 2, members: [fx.self, person('acct_hana')], joined: true },
    { groupSpaceId: 'group_empty', name: 'New group', memberCount: 0, members: [], joined: false },
  ] };
  const server = mockServer({ 'POST rooms/4821/results': { status: 200, body: response } });
  const store = new CommonGroundStore(server.client, { profiles: true });
  store.set({ rooms: { '4821': room('4821') } });
  await store.loadScreen({ name: 'results', code: '4821' });
  const host: CgHost = {
    self: fx.self, profiles: true, memoryAvailable: false, connectors: null, agentFiles: null, device: null,
    openChat: () => undefined, acceptRequest: async () => undefined, contactsChanged: () => undefined,
    openGroup: () => undefined, openUrl: () => undefined,
  };
  const markup = renderToStaticMarkup(createElement(ResultsScreen, { code: '4821', state: store.getSnapshot(), store, host }));
  assert.match(markup, /Memory group/);
  assert.match(markup, /New group/);
  assert.equal((markup.match(/app-group-avatar/g) ?? []).length, 4);
  assert.doesNotMatch(markup, /cg-stack/);
});

test('visual fixture identities use stable canonical avatars instead of uploaded initials', () => {
  const light = commonGroundFixtures('light');
  const dark = commonGroundFixtures('dark');
  assert.equal(light.self.avatarUrl, dark.self.avatarUrl);
  for (const member of [light.self, ...light.room.members]) {
    assert.match(canonicalAvatarImageUrl(member.avatarUrl) ?? '', new RegExp(`boring-marble-v1/${member.accountId}\\.png`));
  }
});

test('the signed-in account avatar replaces its own entry only, and only inside the provider', () => {
  const account = { accountId: 'acct_me', avatarUrl: 'https://images.example.test/me-now.png' };
  const people = [
    { ...person('acct_me'), avatarUrl: null },
    { ...person('acct_hana'), avatarUrl: 'https://images.example.test/hana.png' },
    person('acct_ravi'),
  ];
  const wrapped = renderToStaticMarkup(createElement(CgSignedInAccount, { account }, createElement(CgAvatarGrid, { people, size: 72 })));
  assert.match(wrapped, /me-now\.png/);
  assert.match(wrapped, /hana\.png/);
  assert.match(wrapped, /boring-marble-v1\/acct_ravi\.png/);
  assert.doesNotMatch(wrapped, /boring-marble-v1\/acct_me\.png/);
  const single = renderToStaticMarkup(createElement(CgSignedInAccount, { account }, createElement(CgAvatar, { person: { ...person('acct_me'), avatarUrl: 'https://images.example.test/old.png' }, size: 40 })));
  assert.match(single, /me-now\.png/);
  assert.doesNotMatch(single, /old\.png/);
  const other = renderToStaticMarkup(createElement(CgSignedInAccount, { account }, createElement(CgAvatar, { person: person('acct_ravi'), size: 40 })));
  assert.match(other, /boring-marble-v1\/acct_ravi\.png/);
  const bare = renderToStaticMarkup(createElement(CgAvatarGrid, { people, size: 72 }));
  assert.doesNotMatch(bare, /me-now\.png/);
  assert.match(bare, /boring-marble-v1\/acct_me\.png/);
  const noPhoto = renderToStaticMarkup(createElement(CgSignedInAccount, { account: { accountId: 'acct_me', avatarUrl: null } }, createElement(CgAvatarGrid, { people, size: 72 })));
  assert.match(noPhoto, /boring-marble-v1\/acct_me\.png/);
});

const UPLOADED_ASSET = 'ava_0123456789abcdef0123456789abcdef';
const UPLOADED_MARKER = `kordi-avatar://uploaded/${UPLOADED_ASSET}`;
const UPLOADED_URL = new RegExp(`/v1/avatars/assets/${UPLOADED_ASSET}/256\\.jpg`);

test('an uploaded-photo marker resolves to the account asset for its own entry inside the provider', () => {
  assert.match(canonicalAvatarImageUrl(UPLOADED_MARKER) ?? '', UPLOADED_URL);
  const account = { accountId: 'acct_me', avatarUrl: UPLOADED_MARKER };
  const people = [{ ...person('acct_me'), avatarUrl: null }, person('acct_ravi')];
  const wrapped = renderToStaticMarkup(createElement(CgSignedInAccount, { account }, createElement(CgAvatarGrid, { people, size: 72 })));
  assert.match(wrapped, UPLOADED_URL);
  assert.doesNotMatch(wrapped, /boring-marble-v1\/acct_me\.png/);
  assert.doesNotMatch(wrapped, /kordi-avatar:/);
  assert.match(wrapped, /boring-marble-v1\/acct_ravi\.png/);
});

test('the Grounding page gives the signed-in account its own photo in server-built lists', async () => {
  const { CommonGroundPage } = await import('../src/features/commonGround/CommonGroundPage');
  const self = { accountId: 'acct_me', name: 'Me', avatarUrl: UPLOADED_MARKER };
  const hana = { ...person('acct_hana'), avatarUrl: 'https://images.example.test/hana.png' };
  const results = {
    status: 'ready' as const,
    people: [],
    topics: [],
    suggestion: { label: 'Agent memory', people: [{ ...person('acct_me'), avatarUrl: null }, hana] },
  };
  const server = mockServer({
    'POST rooms/4821/results': { status: 200, body: results },
    'GET rooms/4821': { status: 200, body: room('4821', { members: [hana] }) },
  });
  const store = new CommonGroundStore(server.client, { profiles: true });
  store.set({ loaded: true, owner: owner(), rooms: { '4821': room('4821', { members: [hana] }) } });
  await store.loadScreen({ name: 'results', code: '4821' });
  store.set({ stack: [{ name: 'home' }, { name: 'results', code: '4821' }] });
  const host: CgHost = {
    self, profiles: true, memoryAvailable: false, connectors: null, agentFiles: null, device: null,
    openChat: () => undefined, acceptRequest: async () => undefined, contactsChanged: () => undefined,
    openGroup: () => undefined, openUrl: () => undefined,
  };
  await mount(createElement(CommonGroundPage, { store, host }), async (root) => {
    // The room header grid already draws host.self, so look only inside the suggested row.
    const rows = [...root.querySelectorAll('div')].filter((node) => node.textContent?.includes('Agent memory') && node.querySelector('img'));
    const row = rows[rows.length - 1];
    assert.ok(row, 'the suggested row is rendered');
    const markup = row.innerHTML;
    assert.match(markup, UPLOADED_URL);
    assert.doesNotMatch(markup, /boring-marble-v1\/acct_me\.png/);
    assert.match(markup, /hana\.png/);
    assert.equal(row.querySelectorAll('img').length, 2);
  });
});
