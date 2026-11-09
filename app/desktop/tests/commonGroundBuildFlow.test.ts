import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BUILD_NOT_STARTED, buildFailureMessage, unreadLinkLine } from '../src/features/commonGround/buildRequest';
import { isTransientFailure, CommonGroundError } from '../src/features/commonGround/client';
import { BUILD_POLL_MS, BUILD_START_CHECKS, CommonGroundStore } from '../src/features/commonGround/store';

import { mockServer, owner, profile, type Reply } from './helpers/commonGroundServer';

const work = profile('cgp_work', 'work', 'Work', false);
const request = { memory: false, connectors: false, device: [], links: 'https://scholar.google.com/citations?user=abc', notes: '' };
const idle: Reply = { status: 200, body: owner({ card: null, profile: work }) };
const building: Reply = { status: 200, body: owner({ card: null, profile: work, build: { status: 'building', errorCode: null } }) };
const failed = (errorCode: string): Reply => ({ status: 200, body: owner({ card: null, profile: work, build: { status: 'failed', errorCode } }) });

function storeWith(routes: Record<string, Reply | Reply[]>) {
  const server = mockServer(routes);
  const store = new CommonGroundStore(server.client, { profiles: true, buildCheckMs: 0 });
  store.set({ profiles: [work], profileId: work.profileId, owner: owner({ card: null, profile: work }), loaded: true, stack: [{ name: 'home' }, { name: 'build' }] });
  const cardChecks = () => server.calls.filter((call) => call.method === 'GET' && call.url.includes('/card?')).length;
  return { ...server, store, cardChecks };
}

test('build flow: no answer and 5xx are unknown outcomes; definite refusals are not', () => {
  assert.equal(isTransientFailure(new CommonGroundError('timed out', 0, null)), true);
  assert.equal(isTransientFailure(new CommonGroundError('bad gateway', 502, null)), true);
  assert.equal(isTransientFailure(new CommonGroundError('db', 500, 'common_ground_failed')), true);
  assert.equal(isTransientFailure(new CommonGroundError('off', 503, 'common_ground_unavailable')), false);
  assert.equal(isTransientFailure(new CommonGroundError('limited', 429, 'rate_limited')), false);
  assert.equal(isTransientFailure(new Error('x')), false);
});

test('build flow: a start that timed out follows the build the slow server did start', async () => {
  // The first look still shows no build (the server is still saving it); the second shows it running.
  const { store, cardChecks } = storeWith({ 'POST card/build': { status: 0 }, 'GET card?profile=cgp_work': [idle, building, building] });
  await store.build(request);
  const state = store.getSnapshot();
  assert.equal(state.owner?.build.status, 'building', 'the screen keeps "Building your card"');
  assert.equal(state.notice, null, 'no error for a build that is running');
  assert.equal(state.busy, null);
  assert.equal(cardChecks(), 2);
  assert.equal(await store.poll(), BUILD_POLL_MS);
});

test('build flow: a start with no answer and no build on the card says it did not start', async () => {
  const { store, cardChecks } = storeWith({ 'POST card/build': { status: 504 }, 'GET card?profile=cgp_work': idle });
  await store.build(request);
  assert.equal(store.getSnapshot().notice, BUILD_NOT_STARTED);
  assert.equal(store.getSnapshot().owner?.build.status, 'idle');
  assert.equal(cardChecks(), BUILD_START_CHECKS);
});

test('build flow: a build already running is followed, not reported as an error', async () => {
  const { store } = storeWith({
    'POST card/build': { status: 409, body: { errorCode: 'common_ground_build_in_progress', message: 'Your card is already being built.' } },
    'GET card?profile=cgp_work': building,
  });
  await store.build(request);
  assert.equal(store.getSnapshot().owner?.build.status, 'building');
  assert.equal(store.getSnapshot().notice, null);
});

test('build flow: a poll that fails keeps polling instead of leaving the build', async () => {
  const { store } = storeWith({ 'GET card?profile=cgp_work': [{ status: 0 }, { status: 502 }, building] });
  store.set({ owner: owner({ card: null, profile: work, build: { status: 'building', errorCode: null } }) });
  assert.equal(await store.poll(), BUILD_POLL_MS);
  assert.equal(await store.poll(), BUILD_POLL_MS);
  assert.equal(store.getSnapshot().owner?.build.status, 'building');
  assert.equal(store.getSnapshot().notice, null);
  assert.deepEqual(store.top(), { name: 'build' });
});

test('build flow: a run that ended without a card says why and stays on Build', async () => {
  for (const [code, line] of [
    ['build_interrupted', 'Could not build your card. Try again.'],
    ['build_timed_out', 'Building took too long. Try again.'],
    ['no_topics', 'Nothing here fits this profile. Add a note or choose other sources.'],
  ] as const) {
    const { store } = storeWith({ 'GET card?profile=cgp_work': failed(code), 'GET profiles': { status: 200, body: { profiles: [work] } } });
    store.set({ owner: owner({ card: null, profile: work, build: { status: 'building', errorCode: null } }) });
    assert.equal(await store.poll(), null);
    assert.equal(store.getSnapshot().notice, line);
    assert.equal(buildFailureMessage(code), line);
    assert.deepEqual(store.top(), { name: 'build' });
  }
});

test('build flow: a link the build could not read is named by its site', () => {
  assert.equal(unreadLinkLine('https://scholar.google.com/citations?user=abc'), "Couldn't read scholar.google.com");
  assert.equal(unreadLinkLine('https://www.example.test/~jane'), "Couldn't read example.test");
  assert.equal(unreadLinkLine('not a url'), "Couldn't read not a url");
});
