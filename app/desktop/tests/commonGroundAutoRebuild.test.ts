import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { applyAiConsent, getAiConsentState, resetAiConsent } from '../src/features/aiConsent/aiConsentStore';
import { ACCOUNT_HINT_EVENT_TYPES } from '../src/features/cloud/accountHintEvents';
import { cardMeta, newTopics } from '../src/features/commonGround/cardAuto';
import { notifyCommonGroundCardEvents, subscribeCardHints } from '../src/features/commonGround/cardHints';
import { CardScreen } from '../src/features/commonGround/CardScreen';
import { BUILD_POLL_MS, CommonGroundStore, SYNC_INTERVAL_MS, type CgScreen } from '../src/features/commonGround/store';
import { cardRefreshDue, clearNewTopics, requestCardRefresh } from '../src/features/commonGround/storeAutoRebuild';
import type { CgOwnerView } from '../src/features/commonGround/types';
import { shortDay } from '../src/features/commonGround/wallet';

import { card, mockServer, owner, profile } from './helpers/commonGroundServer';

const work = profile('cgp_work', 'work', 'Work', true);
const render = (store: CommonGroundStore) => renderToStaticMarkup(createElement(CardScreen, { state: store.getSnapshot(), store }));
const newMark = (topic: string) => new RegExp(`title="${topic}">${topic}</span></span><span class="cg-line-new">New</span>`);

test('auto rebuild: the client sends only the setting, with the card', async () => {
  const { calls, client } = mockServer({ 'PUT settings': { status: 200, body: owner({ autoRebuild: true }) } });
  assert.equal((await client.setAutoRebuild(true, 'cgp_work')).autoRebuild, true);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, 'https://cloud.test/v1/cloud/common-ground/settings');
  assert.deepEqual(calls[0].body, { autoRebuild: true, profileId: 'cgp_work' });
});

test('auto rebuild: turning it on needs AI consent; turning it off never asks', async () => {
  const { calls, client } = mockServer({
    'PUT settings': [{ status: 200, body: owner({ autoRebuild: true }) }, { status: 200, body: owner({ autoRebuild: false }) }],
  });
  const store = new CommonGroundStore(client, { profiles: true });
  store.set({ loaded: true, profiles: [work], profileId: 'cgp_work', owner: owner({ autoRebuild: false }) });
  try {
    applyAiConsent('acct_test', 'unset');
    await store.setAutoRebuild(true);
    assert.equal(calls.length, 0);
    assert.equal(getAiConsentState().prompt, 'consent');
    applyAiConsent('acct_test', 'allowed');
    const saving = store.setAutoRebuild(true);
    assert.equal(store.getSnapshot().busy, 'autoRebuild');
    assert.match(render(store), /aria-label="Rebuild automatically" disabled=""/);
    await saving;
    assert.equal(store.getSnapshot().owner?.autoRebuild, true);
    assert.equal(store.getSnapshot().busy, null);
    applyAiConsent('acct_test', 'declined');
    await store.setAutoRebuild(false);
    assert.deepEqual(calls.map((call) => call.body), [{ autoRebuild: true, profileId: 'cgp_work' }, { autoRebuild: false, profileId: 'cgp_work' }]);
    assert.equal(store.getSnapshot().owner?.autoRebuild, false);
  } finally {
    resetAiConsent();
  }
});

test('auto rebuild: the switch sits above Share my card, and only when the server has the setting', () => {
  const store = new CommonGroundStore(mockServer({}).client, { profiles: true });
  store.set({ profiles: [work], profileId: 'cgp_work', owner: owner() });
  assert.doesNotMatch(render(store), /Rebuild automatically/);
  store.set({ owner: owner({ autoRebuild: true }) });
  const html = render(store);
  assert.match(html, /role="switch" aria-checked="true" aria-label="Rebuild automatically"/);
  const auto = html.indexOf('>Rebuild automatically<');
  const share = html.indexOf('>Share my card<');
  assert.ok(auto > html.indexOf('cg-cardpage-share') && auto < share);
});

test('auto rebuild: the meta line ends with Auto, and Updating takes the place of the new-memories count', () => {
  const now = new Date('2026-10-25T12:00:00Z');
  const base = `1 line · built ${shortDay(card.builtAt, now)}`;
  assert.deepEqual(cardMeta(card, { memoriesSinceBuild: 3 }, true, now), { base, newMemories: '3 new memories', status: null });
  assert.deepEqual(cardMeta(card, { memoriesSinceBuild: 3, autoRebuild: true }, true, now), { base, newMemories: '3 new memories', status: 'Auto' });
  assert.deepEqual(cardMeta(card, { memoriesSinceBuild: 3, autoRebuild: true, autoUpdating: true }, true, now), { base, newMemories: null, status: 'Updating' });
  assert.deepEqual(cardMeta(card, { memoriesSinceBuild: 3, autoRebuild: false }, false, now), { base, newMemories: null, status: null });
  assert.equal(cardMeta({ ...card, workingOn: ['A', 'B'], builtAt: null }, {}, true, now).base, '2 lines');
  const store = new CommonGroundStore(mockServer({}).client, { profiles: true });
  store.set({ profiles: [work], profileId: 'cgp_work', owner: owner({ autoRebuild: true, autoUpdating: true }) });
  assert.match(render(store), /<span data-cg-auto-rebuild=""> · Updating<\/span><\/div>/);
});

test('auto rebuild: new topics are the ones the card did not have, ignoring case', () => {
  const before = { ...card, workingOn: ['Agent memory'], interests: ['Retrieval'] };
  const after = { ...card, workingOn: ['agent memory', 'Eval design'], interests: ['Retrieval'], canHelp: ['User studies'] };
  assert.deepEqual(newTopics(before, after), ['Eval design', 'User studies']);
  assert.deepEqual(newTopics(null, after), []);
  assert.deepEqual(newTopics(before, null), []);
});

test('auto rebuild: the card hint passes the sync mapping and reaches the page once per batch', () => {
  assert.ok(ACCOUNT_HINT_EVENT_TYPES.has('common_ground.card.updated'));
  let heard = 0;
  const stop = subscribeCardHints(() => { heard += 1; });
  notifyCommonGroundCardEvents([{ eventType: 'common_ground.card.updated' }, { eventType: 'common_ground.card.updated' }]);
  notifyCommonGroundCardEvents([{ eventType: 'common_ground.nearby.updated' }]);
  stop();
  notifyCommonGroundCardEvents([{ eventType: 'common_ground.card.updated' }]);
  assert.equal(heard, 1);
});

test('auto rebuild: a hint refetches the cards and the card, and marks added topics on the card page only', async () => {
  const updated = owner({ card: { ...card, workingOn: ['Agent memory', 'Eval design'] }, autoRebuild: true });
  const { calls, client } = mockServer({
    'GET profiles': { status: 200, body: { profiles: [{ ...work, topicCount: 2 }] } },
    'GET card?profile=cgp_work': { status: 200, body: updated },
  });
  const store = new CommonGroundStore(client, { profiles: true });
  store.set({ loaded: true, profiles: [work], profileId: 'cgp_work', owner: owner({ autoRebuild: true }), stack: [{ name: 'home' }, { name: 'card' }] });
  assert.equal(await requestCardRefresh(store), null);
  assert.deepEqual(calls.map((call) => call.url.split('common-ground/')[1]), ['profiles', 'card?profile=cgp_work']);
  assert.deepEqual(store.getSnapshot().owner?.card?.workingOn, ['Agent memory', 'Eval design']);
  assert.equal(store.getSnapshot().profiles[0].topicCount, 2);
  assert.equal(cardRefreshDue(store), false);
  const html = render(store);
  assert.match(html, newMark('Eval design'));
  assert.equal(html.split('cg-line-new').length - 1, 1);
  // Leaving the card page drops the marks.
  clearNewTopics(store);
  assert.doesNotMatch(render(store), /cg-line-new/);
  // On Home the card updates without marks.
  store.set({ stack: [{ name: 'home' }], owner: owner({ autoRebuild: true }) });
  await requestCardRefresh(store);
  assert.deepEqual(store.getSnapshot().owner?.card?.workingOn, ['Agent memory', 'Eval design']);
  assert.doesNotMatch(render(store), /cg-line-new/);
});

test('auto rebuild: a refresh waits for a save in flight and never overwrites an edit', async () => {
  const fromServer = owner({ card: { ...card, workingOn: ['Server topic'] } });
  const { client } = mockServer({ 'GET card?profile=cgp_work': { status: 200, body: fromServer } });
  const store = new CommonGroundStore(client);
  store.set({ loaded: true, profileId: 'cgp_work', owner: owner(), stack: [{ name: 'card' }], busy: 'topics' });
  await requestCardRefresh(store);
  assert.deepEqual(store.getSnapshot().owner?.card?.workingOn, ['Agent memory']);
  assert.equal(cardRefreshDue(store), true);
  // An edit made while the fetch is out wins; the refresh waits for the next poll.
  store.set({ busy: null });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchCard = client.card;
  client.card = async (profileId?: string | null): Promise<CgOwnerView> => {
    await gate;
    return fetchCard(profileId);
  };
  const polling = store.poll();
  const edited = owner({ card: { ...card, workingOn: ['Agent memory', 'My edit'] } });
  store.set({ owner: edited });
  release();
  await polling;
  assert.equal(store.getSnapshot().owner, edited);
  assert.equal(cardRefreshDue(store), true);
  await store.poll();
  assert.deepEqual(store.getSnapshot().owner?.card?.workingOn, ['Server topic']);
  assert.equal(cardRefreshDue(store), false);
});

test('auto rebuild: while an automatic update runs, the poll fetches the card on the build interval', async () => {
  const running = owner({ autoRebuild: true, autoUpdating: true });
  const landed = owner({ card: { ...card, workingOn: ['Agent memory', 'Eval design'] }, autoRebuild: true, autoUpdating: false });
  const { calls, client } = mockServer({ 'GET card': [{ status: 200, body: running }, { status: 200, body: landed }] });
  const store = new CommonGroundStore(client);
  store.set({ loaded: true, owner: running, stack: [{ name: 'home' }, { name: 'card' }] });
  assert.match(render(store), /data-cg-auto-rebuild=""> · Updating</);
  assert.equal(cardRefreshDue(store), true);
  assert.equal(await store.poll(), BUILD_POLL_MS);
  assert.equal(await store.poll(), null);
  assert.equal(calls.length, 2);
  assert.equal(store.getSnapshot().owner?.autoUpdating, false);
  assert.equal(cardRefreshDue(store), false);
  const html = render(store);
  assert.match(html, /data-cg-auto-rebuild=""> · Auto</);
  assert.match(html, newMark('Eval design'));
  clearNewTopics(store);
});

// Every background fetch of the open card marks what it added, whichever one arrives first.

const evalDesign = owner({ card: { ...card, workingOn: ['Agent memory', 'Eval design'] }, autoRebuild: true });

function syncServer(cards: CgOwnerView[]) {
  return mockServer({
    'GET profiles': { status: 200, body: { profiles: [work] } },
    'GET card?profile=cgp_work': cards.map((body) => ({ status: 200, body })),
    'GET rooms': { status: 200, body: { rooms: [] } },
    'GET recent': { status: 200, body: { people: [] } },
    'PUT card?profile=cgp_work': { status: 200, body: cards[cards.length - 1] },
  });
}

function cardPageStore(client: ReturnType<typeof mockServer>['client'], stack: CgScreen[]) {
  const store = new CommonGroundStore(client, { profiles: true });
  store.set({ loaded: true, profiles: [work], profileId: 'cgp_work', owner: owner({ autoRebuild: true }), stack });
  return store;
}

const later = () => Date.now() + SYNC_INTERVAL_MS;

test('auto rebuild: a regular sync that brings a new topic while the card page is open marks it', async () => {
  const store = cardPageStore(syncServer([evalDesign]).client, [{ name: 'home' }, { name: 'card' }]);
  assert.equal(await store.syncFromServer(later()), true);
  assert.deepEqual(store.getSnapshot().owner?.card?.workingOn, ['Agent memory', 'Eval design']);
  assert.match(render(store), newMark('Eval design'));
  clearNewTopics(store);
});

test('auto rebuild: the hint arriving after that sync neither clears nor repeats the mark', async () => {
  const { calls, client } = syncServer([evalDesign]);
  const store = cardPageStore(client, [{ name: 'home' }, { name: 'card' }]);
  await store.syncFromServer(later());
  assert.equal(await requestCardRefresh(store), null);
  assert.equal(calls.filter((call) => call.url.endsWith('card?profile=cgp_work')).length, 2);
  const html = render(store);
  assert.match(html, newMark('Eval design'));
  assert.equal(html.split('cg-line-new').length - 1, 1);
  clearNewTopics(store);
});

test('auto rebuild: a topic the owner adds is never marked, even when a background fetch started before the save', async () => {
  const typed = owner({ card: { ...card, workingOn: ['Agent memory', 'My topic'] }, autoRebuild: true });
  // The sync's fetch answers with the card from before the save; later fetches with the saved card.
  const { client } = syncServer([owner({ autoRebuild: true }), typed]);
  const store = cardPageStore(client, [{ name: 'home' }, { name: 'card' }]);
  let entered!: () => void;
  let release!: () => void;
  const fetching = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchCard = client.card;
  client.card = async (profileId?: string | null): Promise<CgOwnerView> => {
    entered();
    await gate;
    return fetchCard(profileId);
  };
  const syncing = store.syncFromServer(later());
  await fetching;
  await store.saveTopics({ workingOn: ['Agent memory', 'My topic'], interests: [], canHelp: [], lookingFor: [] });
  release();
  await syncing;
  assert.deepEqual(store.getSnapshot().owner?.card?.workingOn, ['Agent memory', 'My topic']);
  await requestCardRefresh(store);
  assert.deepEqual(store.getSnapshot().owner?.card?.workingOn, ['Agent memory', 'My topic']);
  assert.doesNotMatch(render(store), /cg-line-new/);
});

test('auto rebuild: no marks when the card page is not on top', async () => {
  const store = cardPageStore(syncServer([evalDesign]).client, [{ name: 'home' }]);
  await store.syncFromServer(later());
  await requestCardRefresh(store);
  assert.deepEqual(store.getSnapshot().owner?.card?.workingOn, ['Agent memory', 'Eval design']);
  store.set({ stack: [{ name: 'home' }, { name: 'card' }] });
  assert.doesNotMatch(render(store), /cg-line-new/);
});
