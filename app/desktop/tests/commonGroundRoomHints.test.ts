import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACCOUNT_HINT_EVENT_TYPES } from '../src/features/cloud/accountHintEvents';
import { syncCloudDiffOnce } from '../src/features/cloud/cloudDiffSync';
import { ChatSyncState } from '../src/features/cloud/chatSyncState';
import { ChatSyncSyncClient } from '../src/features/cloud/chatSyncSyncClient';
import type { ChatSyncEvent, ChatSyncSyncResponse } from '../src/features/cloud/chatSyncTypes';
import { notifyCommonGroundRoomEvents, subscribeRoomHints, type CgRoomHints } from '../src/features/commonGround/roomHints';
import {
  CommonGroundStore, LOBBY_FALLBACK_POLL_MS, LOBBY_POLL_MS, MATCH_FALLBACK_POLL_MS, MATCH_POLL_MS, type CgScreen,
} from '../src/features/commonGround/store';
import { receiveRoomHints } from '../src/features/commonGround/storeHints';
import type { CgResults } from '../src/features/commonGround/types';
import { mockServer, owner, person, room } from './helpers/commonGroundServer';

const results = (people: string[], status: CgResults['status'] = 'ready'): CgResults => (
  { status, people: people.map((id) => ({ person: person(id), score: 80, headline: 'Shared work' })), topics: [], suggestion: null }
);
const roomHint = (code: string): CgRoomHints => ({ codes: [code], matches: false });
const matchHint: CgRoomHints = { codes: [], matches: true };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const home: CgScreen = { name: 'home' };

/** A store with `screen` open over Home, as after opening it from the Rooms list. */
function storeAt(client: CommonGroundStore['client'], screen: CgScreen, cached: Partial<ReturnType<CommonGroundStore['getSnapshot']>> = {}) {
  const store = new CommonGroundStore(client);
  store.set({ loaded: true, owner: owner(), stack: [home, screen], ...cached });
  return store;
}

test('room hints: only the two types pass the sync mapping and notify, with each room code once per batch', () => {
  assert.ok(ACCOUNT_HINT_EVENT_TYPES.has('common_ground.room.updated'));
  assert.ok(ACCOUNT_HINT_EVENT_TYPES.has('common_ground.matches.updated'));
  const heard: CgRoomHints[] = [];
  const stop = subscribeRoomHints((hints) => heard.push(hints));
  notifyCommonGroundRoomEvents([
    { eventType: 'common_ground.room.updated', payload: { code: '4821' } },
    { eventType: 'common_ground.room.updated', payload: { code: '4821' } },
    { eventType: 'common_ground.room.updated', payload: { code: '1907' } },
    { eventType: 'common_ground.card.updated', payload: { code: '5550' } },
  ]);
  notifyCommonGroundRoomEvents([{ eventType: 'common_ground.matches.updated', payload: { profileId: 'p1' } }]);
  notifyCommonGroundRoomEvents([{ eventType: 'common_ground.nearby.updated' }, { eventType: 'common_ground.room.updated', payload: {} }]);
  stop();
  notifyCommonGroundRoomEvents([{ eventType: 'common_ground.matches.updated' }]);
  assert.deepEqual(heard, [{ codes: ['4821', '1907'], matches: false }, { codes: [], matches: true }]);
});

test('room hints: the chat sync hands room codes to an open Grounding page', async () => {
  const hint = (seq: number, type: string, payload: unknown): ChatSyncEvent => ({
    stream_seq: seq, event_id: `hint-${seq}`, protocol_version: 2, type, critical: false,
    conversation_id: null, entity_id: null, entity_version: null, occurred_at: '2026-11-12T00:00:00Z', payload,
  });
  const response = {
    protocol_version: 2, next_cursor: '4', last_stream_seq: 4, has_more: false, server_time: '2026-11-12T00:00:00Z',
    events: [hint(2, 'common_ground.room.updated', { code: '4821' }), hint(3, 'common_ground.matches.updated', { profileId: 'p1' }), hint(4, 'common_ground.room.updated', { code: '4821' })],
  } satisfies ChatSyncSyncResponse;
  const account = 'acct_owner';
  const client = new ChatSyncSyncClient(new ChatSyncState(async () => response, () => account, () => undefined, () => null));
  const heard: CgRoomHints[] = [];
  const stop = subscribeRoomHints((hints) => heard.push(hints));
  try {
    await syncCloudDiffOnce({
      accountId: account, messagesByPeer: {}, loadCursor: async () => '1', commitResponse: async () => undefined,
      fetchEvents: (cursor) => client.syncCloudEvents('token', cursor),
    });
  } finally { stop(); }
  assert.deepEqual(heard, [{ codes: ['4821'], matches: true }]);
});

test('a room hint re-requests ready Results for that room once and shows the new person', async () => {
  const { calls, client } = mockServer({
    'GET rooms/4821': { status: 200, body: room('4821', { members: [person('a'), person('b')] }) },
    'POST rooms/4821/results': { status: 200, body: results(['a', 'b']) },
  });
  const store = storeAt(client, { name: 'results', code: '4821' }, { results: { '4821': results(['a']) }, rooms: { '4821': room('4821') } });
  const requests = () => calls.filter((call) => call.url.endsWith('/rooms/4821/results')).length;
  await receiveRoomHints(store, roomHint('1907'));
  assert.equal(calls.length, 0, 'a hint for another room does nothing');
  assert.equal(await store.poll(), null, 'ready Results still do not poll');
  assert.equal(calls.length, 0);
  await receiveRoomHints(store, roomHint('4821'));
  assert.equal(requests(), 1);
  assert.deepEqual(store.getSnapshot().results['4821'].people.map((entry) => entry.person.accountId), ['a', 'b']);
  assert.equal(store.getSnapshot().rooms['4821'].members.length, 2);
});

test('a room hint re-reads the lobby and moves it to Results once matching started', async () => {
  const { calls, client } = mockServer({
    'GET rooms/4821': { status: 200, body: room('4821', { members: [person('a'), person('b')], matchingStarted: true }) },
    'POST rooms/4821/results': { status: 200, body: results([], 'matching') },
  });
  const store = storeAt(client, { name: 'lobby', code: '4821' }, { rooms: { '4821': room('4821') } });
  await receiveRoomHints(store, roomHint('4821'));
  assert.deepEqual(store.top(), { name: 'results', code: '4821' });
  assert.equal(store.getSnapshot().stack.length, 2, 'Results replaces the lobby');
  assert.ok(calls.some((call) => call.method === 'GET' && call.url.endsWith('/rooms/4821')));
});

test('hints during a refresh in flight cause exactly one more request, and a poll waits for it', async () => {
  const { client } = mockServer({});
  const pending: Array<() => void> = [];
  let requests = 0;
  client.results = () => {
    requests += 1;
    const people = requests === 1 ? ['a'] : ['a', 'b'];
    return new Promise((resolve) => { pending.push(() => resolve(results(people, 'matching'))); });
  };
  client.room = async () => room('4821');
  const store = storeAt(client, { name: 'results', code: '4821' }, { results: { '4821': results([], 'matching') } });
  const first = receiveRoomHints(store, roomHint('4821'));
  const second = receiveRoomHints(store, roomHint('4821'));
  const third = receiveRoomHints(store, matchHint);
  const poll = store.poll();
  await tick();
  assert.equal(requests, 1, 'one refresh of the screen at a time');
  pending.shift()!();
  await tick();
  assert.equal(requests, 2, 'one more after it for the hints that arrived meanwhile');
  pending.shift()!();
  await Promise.all([first, second, third]);
  assert.equal(await poll, MATCH_FALLBACK_POLL_MS);
  assert.equal(requests, 2);
  assert.equal(pending.length, 0);
  assert.deepEqual(store.getSnapshot().results['4821'].people.map((entry) => entry.person.accountId), ['a', 'b']);
});

test('a hint refresh set aside by another change runs again instead of being lost, never landing a stale result', async () => {
  const { client } = mockServer({});
  let release!: () => void;
  const answers = [
    () => new Promise<CgResults>((resolve) => { release = () => resolve(results(['a'])); }),
    async () => results(['a', 'b']),
    async () => results(['a', 'b', 'c']),
  ];
  client.results = () => answers.shift()!();
  client.room = async () => room('4821');
  const store = storeAt(client, { name: 'results', code: '4821' }, { results: { '4821': results([]) } });
  const seen: number[] = [];
  store.subscribe(() => seen.push(store.getSnapshot().results['4821']?.people.length ?? -1));
  const hinted = receiveRoomHints(store, roomHint('4821'));
  // A newer refresh from another path lands while the hint's request is out.
  await store.loadScreen();
  assert.equal(store.getSnapshot().results['4821'].people.length, 2);
  release();
  await hinted;
  assert.equal(answers.length, 0, 'the hint asked once more');
  assert.deepEqual(store.getSnapshot().results['4821'].people.map((entry) => entry.person.accountId), ['a', 'b', 'c']);
  assert.ok(!seen.includes(1), 'the older answer never landed over the newer one');
});

test('a match hint refreshes a match page that is still matching; a room hint does not', async () => {
  const { calls, client } = mockServer({
    'GET people/acct_b/match': [
      { status: 202, body: { status: 'matching', person: person('acct_b') } },
      { status: 200, body: { score: 40, headline: 'h', shared: [], youBring: [], theyBring: [], nextStep: '', status: 'ready', person: person('acct_b') } },
    ],
  });
  const store = new CommonGroundStore(client);
  store.open({ name: 'match', accountId: 'acct_b' });
  await tick();
  assert.equal(store.getSnapshot().matches.acct_b.status, 'matching');
  await receiveRoomHints(store, roomHint('4821'));
  assert.equal(calls.length, 1);
  await receiveRoomHints(store, matchHint);
  assert.equal(calls.length, 2);
  assert.equal(store.getSnapshot().matches.acct_b.score, 40);
});

test('on Home a room hint refreshes the Rooms list; a match hint there and other screens ignore hints', async () => {
  const summary = { code: '4821', name: '', open: true, memberCount: 3, joinedAt: '', lastActivityAt: '', themeCount: 2 };
  const { calls, client } = mockServer({ 'GET rooms': { status: 200, body: { rooms: [summary] } } });
  const store = new CommonGroundStore(client);
  store.set({ loaded: true, owner: owner() });
  await receiveRoomHints(store, matchHint);
  assert.equal(calls.length, 0);
  await receiveRoomHints(store, roomHint('4821'));
  assert.deepEqual(store.getSnapshot().roomList.map((entry) => entry.memberCount), [3]);
  store.set({ stack: [home, { name: 'card' }] });
  await receiveRoomHints(store, { codes: ['4821'], matches: true });
  assert.equal(calls.length, 1);
});

test('a hint waits for a user action and for the window to show, and does nothing after dispose', async () => {
  const { calls, client } = mockServer({
    'GET rooms/4821': { status: 200, body: room('4821') },
    'POST rooms/4821/results': { status: 200, body: results(['a', 'b']) },
  });
  const store = storeAt(client, { name: 'results', code: '4821' }, { results: { '4821': results(['a']) } });
  const requests = () => calls.filter((call) => call.url.endsWith('/rooms/4821/results')).length;
  store.set({ busy: 'group' });
  await receiveRoomHints(store, roomHint('4821'));
  assert.equal(requests(), 0, 'no refresh over an action in flight');
  store.set({ busy: null });
  await tick();
  assert.equal(requests(), 1, 'runs once the action finished');
  let hidden = true;
  await receiveRoomHints(store, roomHint('4821'), () => hidden);
  assert.equal(requests(), 1, 'no refresh while hidden');
  hidden = false;
  assert.equal(await store.poll(), null, 'the window shows again');
  await tick();
  assert.equal(requests(), 2, 'the held hint runs on the next poll');
  store.dispose();
  await receiveRoomHints(store, roomHint('4821'));
  await tick();
  assert.equal(requests(), 2);
});

test('polling keeps today\'s pace until the first hint, then falls back to the slower one', async () => {
  const { client } = mockServer({
    'GET rooms/4821': { status: 200, body: room('4821') },
    'GET rooms/1907': { status: 200, body: room('1907') },
    'POST rooms/1907/results': { status: 200, body: results([], 'matching') },
  });
  const lobby: CgScreen = { name: 'lobby', code: '4821' };
  const matching: CgScreen = { name: 'results', code: '1907' };
  const store = storeAt(client, lobby, { results: { '1907': results([], 'matching') } });
  assert.equal(await store.poll(), LOBBY_POLL_MS);
  store.set({ stack: [home, matching] });
  assert.equal(await store.poll(), MATCH_POLL_MS);
  // A hint for a room not on screen still shows the stream delivers them.
  await receiveRoomHints(store, roomHint('5550'));
  assert.equal(await store.poll(), MATCH_FALLBACK_POLL_MS);
  store.set({ stack: [home, lobby] });
  assert.equal(await store.poll(), LOBBY_FALLBACK_POLL_MS);
  assert.equal(LOBBY_FALLBACK_POLL_MS, 10_000);
  assert.equal(MATCH_FALLBACK_POLL_MS, 10_000);
});
