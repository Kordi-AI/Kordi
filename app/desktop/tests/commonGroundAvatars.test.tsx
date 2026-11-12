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
import { mockServer, person, room } from './helpers/commonGroundServer';

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
  await store.findCommonGround('4821');
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
