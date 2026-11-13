import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CloudContactProfile, CloudContactProfileGroup } from '../src/features/cloud/contactProfileClient';
import { SharedWithYouCard } from '../src/kordi-app/contacts/ContactProfileCards';
import { commonGroupAvatar, commonGroupSpace } from '../src/kordi-app/contacts/commonGroupAvatars';
import type { ParticipantSpaceViewModel } from '../src/kordi-app/types';

function space(id: string, overrides: Partial<ParticipantSpaceViewModel> = {}): ParticipantSpaceViewModel {
  return {
    id,
    kind: 'group',
    title: id,
    participants: [],
    participantCount: 2,
    sessionCount: 1,
    unread: 0,
    updatedAtMs: 0,
    preview: '',
    avatarStack: [
      { kind: 'human', seed: `${id}-a`, imageUrl: `https://example.test/${id}-a.png` },
      { kind: 'human', seed: `${id}-b`, imageUrl: null },
    ],
    sessions: [],
    ...overrides,
  };
}

const group = (groupId: string, avatarUrl: string | null = null): CloudContactProfileGroup => ({ groupId, title: `Group ${groupId}`, avatarUrl });

test('common groups resolve to the loaded group space by its unprefixed id', () => {
  const spaces = [space('direct-human:acct_x', { kind: 'direct-human' }), space('group:gs_lab'), space('group:gs_reading')];
  assert.equal(commonGroupSpace(group('gs_reading'), spaces)?.id, 'group:gs_reading');
  assert.equal(commonGroupSpace(group('group:gs_lab'), spaces)?.id, 'group:gs_lab');
  assert.equal(commonGroupSpace(group('gs_missing'), spaces), null);
  assert.equal(commonGroupSpace(group('gs_lab'), undefined), null);
});

test('a group without a space id matches the space that holds its session', () => {
  const legacy = space('group:cloud:acct_a+acct_b', {
    sessions: [{
      id: 'local-session', canonicalSessionId: 'group:conv_123', title: '', preview: '', unread: 0, updatedAtMs: 0, participantCount: 2,
      conversation: { id: 'local-session' } as ParticipantSpaceViewModel['sessions'][number]['conversation'],
    }],
  });
  assert.equal(commonGroupSpace(group('conv_123'), [legacy])?.id, legacy.id);
  assert.equal(commonGroupSpace(group('conv_hidden'), [space('group:other', { membershipSessionIds: ['conv_hidden'] })])?.id, 'group:other');
});

test('the avatar uses the sidebar picture and member mosaic, else the server picture, else nothing', () => {
  const pictured = space('group:gs_pic', { groupAvatar: { imageUrl: 'https://example.test/local.png', updatedAtMs: 1 } });
  const mosaic = space('group:gs_mosaic');
  const spaces = [pictured, mosaic];

  const withPicture = commonGroupAvatar(group('gs_pic', 'https://example.test/server.png'), spaces);
  assert.equal(withPicture.imageUrl, 'https://example.test/local.png');
  assert.deepEqual(withPicture.avatars, pictured.avatarStack);

  const withMembers = commonGroupAvatar(group('gs_mosaic', 'https://example.test/server.png'), spaces);
  assert.equal(withMembers.imageUrl, 'https://example.test/server.png');
  assert.equal(withMembers.avatars.length, 2);

  const unloaded = commonGroupAvatar(group('gs_gone'), spaces);
  assert.equal(unloaded.imageUrl, null);
  assert.deepEqual(unloaded.avatars, []);
});

test('Groups in common is a count row like Photos, Files and Links, without group avatars', () => {
  const shared: CloudContactProfile['shared'] = { mediaCount: 0, linkCount: 0, documentCount: 0, groups: [group('gs_lab'), group('gs_gone')] };
  const markup = renderToStaticMarkup(createElement(SharedWithYouCard, {
    shared,
    onOpenGroup: () => undefined,
    groupSpaces: [space('group:gs_lab')],
  }));
  const row = markup.slice(markup.indexOf('Groups in common'));
  assert.doesNotMatch(row, /app-group-avatar/);
  assert.match(row, /app-contacts-shared-count[^>]*>2</);
});
