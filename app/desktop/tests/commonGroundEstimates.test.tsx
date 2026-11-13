import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CgHost } from '../src/features/commonGround/host';
import { MatchDetails, MatchScreen } from '../src/features/commonGround/MatchScreen';
import { ResultsScreen } from '../src/features/commonGround/ResultsScreen';
import { CommonGroundStore, MATCH_POLL_MS, personKey } from '../src/features/commonGround/store';
import { mockServer, person, room } from './helpers/commonGroundServer';

const self = person('acct_self');
const host: CgHost = {
  self, profiles: false, memoryAvailable: false, connectors: null, agentFiles: null, device: null,
  openChat: () => undefined, acceptRequest: async () => undefined, contactsChanged: () => undefined,
  openGroup: () => undefined, openUrl: () => undefined,
};

const estimate = {
  status: 'matching',
  person: person('acct_b'),
  profileId: 'prof_1',
  score: 41,
  headline: 'Agent memory',
  shared: [{ topic: 'Agent memory', theirTopic: 'Memory for agents', why: '' }],
  youBring: [{ topic: 'Evaluation', for: 'Benchmarks', why: '' }],
  theyBring: [],
  nextStep: '',
  estimated: true,
};

test('results keep estimated people and mark only them', async () => {
  const { client } = mockServer({
    'POST rooms/4821/results': { status: 200, body: { status: 'matching', topics: [], suggestion: null, people: [
      { person: person('acct_a'), score: 82, headline: 'Ready reasons' },
      { person: person('acct_b'), score: 41, headline: 'Agent memory', estimated: true },
      { person: person('acct_c'), score: 12, headline: 'Gardening', estimated: 'yes' },
    ] } },
  });
  const people = (await client.results('4821')).people;
  assert.deepEqual(people.map((entry) => entry.person.accountId), ['acct_a', 'acct_b', 'acct_c']);
  assert.equal('estimated' in people[0], false);
  assert.equal(people[1].estimated, true);
  assert.equal('estimated' in people[2], false, 'only a literal true counts');
});

test('estimated people show as ordinary rows that open the match, with the progress line while matching', async () => {
  const members = [person('acct_a'), person('acct_b')];
  const body = (status: string) => ({ status, topics: [], suggestion: null, people: [
    { person: members[0], score: 82, headline: 'Ready reasons' },
    { person: members[1], score: 41, headline: 'Agent memory', estimated: true },
  ] });
  const { client } = mockServer({ 'POST rooms/4821/results': [{ status: 200, body: body('matching') }, { status: 200, body: body('ready') }] });
  const store = new CommonGroundStore(client);
  store.set({ rooms: { '4821': room('4821', { members }) } });
  await store.loadScreen({ name: 'results', code: '4821' });
  const markup = renderToStaticMarkup(createElement(ResultsScreen, { code: '4821', state: store.getSnapshot(), store, host }));
  assert.equal((markup.match(/class="cg-row is-button"/g) ?? []).length, 2, 'both people are listed, once each');
  assert.match(markup, /Agent memory/);
  assert.match(markup, /41/);
  assert.match(markup, /cg-progress is-inline/);
  assert.doesNotMatch(markup, /[Ee]stimate/, 'no extra copy');

  await store.loadScreen({ name: 'results', code: '4821' });
  const ready = renderToStaticMarkup(createElement(ResultsScreen, { code: '4821', state: store.getSnapshot(), store, host }));
  assert.equal((ready.match(/class="cg-row is-button"/g) ?? []).length, 2);
  assert.doesNotMatch(ready, /cg-progress/, 'ready results stop the line even with estimated people');
});

test('a 202 match keeps the estimate topics and tolerates missing fields', async () => {
  const { client } = mockServer({
    'GET people/acct_b/match?profile=prof_1': [
      { status: 202, body: estimate },
      { status: 202, body: { status: 'matching', person: person('acct_b'), shared: [{ topic: 'Rust' }, { why: 'no topic' }, null], youBring: 'x' } },
      { status: 202, body: { status: 'matching', person: person('acct_b'), profileId: 'prof_1' } },
    ],
  });
  const first = await client.match('acct_b', 'prof_1');
  assert.equal(first.status, 'matching');
  assert.equal(first.estimated, true);
  assert.equal(first.score, 41);
  assert.equal(first.headline, 'Agent memory');
  assert.deepEqual(first.shared, estimate.shared);
  assert.deepEqual(first.youBring, estimate.youBring);
  assert.deepEqual(first.theyBring, []);
  assert.equal(first.nextStep, '');

  const partial = await client.match('acct_b', 'prof_1');
  assert.deepEqual(partial.shared, [{ topic: 'Rust', theirTopic: '', why: '' }]);
  assert.deepEqual(partial.youBring, []);
  assert.deepEqual(partial.theyBring, []);
  assert.equal(partial.nextStep, '');
  assert.equal('score' in partial, false);

  const older = await client.match('acct_b', 'prof_1');
  assert.equal(older.status, 'matching');
  assert.equal(older.profileId, 'prof_1');
  for (const key of ['score', 'headline', 'shared', 'youBring', 'theyBring', 'nextStep', 'estimated']) {
    assert.equal(key in older, false, `an older server adds no ${key}`);
  }
});

test('matching with estimate topics shows them at once, without empty reasons or next step', () => {
  const markup = renderToStaticMarkup(createElement(MatchDetails, { match: { ...estimate, status: 'matching' } }));
  assert.match(markup, /role="tablist"/);
  assert.match(markup, /Agent memory/);
  assert.doesNotMatch(markup, /cg-row-sub/, 'empty why lines stay hidden');
  assert.doesNotMatch(markup, /cg-next-step/);
  assert.doesNotMatch(markup, /No clear overlap yet/);
  assert.match(markup, /cg-progress is-inline/);
  assert.match(markup, /Finding what you share/);
});

test('matching without estimate topics keeps the full progress line', () => {
  const markup = renderToStaticMarkup(createElement(MatchDetails, { match: { status: 'matching', person: person('acct_b') } }));
  assert.doesNotMatch(markup, /role="tablist"/);
  assert.match(markup, /class="cg-progress"/);
  assert.match(markup, /Finding what you share/);
});

test('ready matches still show reasons and drop the progress line', () => {
  const markup = renderToStaticMarkup(createElement(MatchDetails, { match: {
    status: 'ready', person: person('acct_b'),
    shared: [{ topic: 'Agent memory', theirTopic: 'Memory for agents', why: 'Both build long-term memory.' }],
    youBring: [], theyBring: [], nextStep: 'Compare eval sets.',
  } }));
  assert.match(markup, /Both build long-term memory\./);
  assert.match(markup, /Compare eval sets\./);
  assert.doesNotMatch(markup, /cg-progress/);
});

test('store: an estimated match keeps polling and turns ready with reasons', async () => {
  const { client } = mockServer({
    'GET people/acct_b/match?profile=prof_1': [
      { status: 202, body: estimate },
      { status: 202, body: estimate },
      { status: 200, body: { ...estimate, estimated: undefined, status: 'ready', score: 77, shared: [{ topic: 'Agent memory', theirTopic: 'Memory', why: 'Same problem.' }], nextStep: 'Talk.' } },
    ],
  });
  const store = new CommonGroundStore(client);
  store.open({ name: 'match', accountId: 'acct_b', profileId: 'prof_1' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const key = personKey('acct_b', 'prof_1');
  assert.equal(store.getSnapshot().matches[key].status, 'matching');
  assert.equal(store.getSnapshot().matches[key].shared?.length, 1);
  const pending = renderToStaticMarkup(createElement(MatchScreen, { accountId: 'acct_b', profileId: 'prof_1', state: store.getSnapshot(), store, host }));
  assert.match(pending, /Agent memory/);
  assert.match(pending, /cg-progress is-inline/);
  assert.equal(await store.poll(), MATCH_POLL_MS);
  assert.equal(await store.poll(), null);
  const ready = store.getSnapshot().matches[key];
  assert.equal(ready.status, 'ready');
  assert.equal(ready.score, 77);
  assert.equal(ready.estimated, undefined);
  const done = renderToStaticMarkup(createElement(MatchScreen, { accountId: 'acct_b', profileId: 'prof_1', state: store.getSnapshot(), store, host }));
  assert.match(done, /Same problem\./);
  assert.doesNotMatch(done, /cg-progress/);
});

test('a ready match that is only an estimate shows its topics without reasons and stops polling', async () => {
  const { client } = mockServer({
    'GET people/acct_b/match?profile=prof_1': { status: 200, body: { ...estimate, status: 'ready' } },
  });
  const store = new CommonGroundStore(client);
  store.open({ name: 'match', accountId: 'acct_b', profileId: 'prof_1' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const match = store.getSnapshot().matches[personKey('acct_b', 'prof_1')];
  assert.equal(match.status, 'ready');
  assert.equal(match.estimated, true);
  assert.deepEqual(match.shared, estimate.shared);
  assert.equal(await store.poll(), null, 'ready is final even when estimated');
  const markup = renderToStaticMarkup(createElement(MatchScreen, { accountId: 'acct_b', profileId: 'prof_1', state: store.getSnapshot(), store, host }));
  assert.match(markup, /Agent memory/);
  assert.match(markup, /class="cg-badge">41%/);
  assert.doesNotMatch(markup, /cg-row-sub/, 'no empty why lines');
  assert.doesNotMatch(markup, /cg-next-step/);
  assert.doesNotMatch(markup, /cg-progress/);
});

test('a normal ready match carries no estimated key', async () => {
  const { client } = mockServer({
    'GET people/acct_b/match': { status: 200, body: { status: 'ready', person: person('acct_b'), score: 70, headline: 'h', shared: [], youBring: [], theyBring: [], nextStep: 'Talk.' } },
  });
  const match = await client.match('acct_b');
  assert.equal(match.status, 'ready');
  assert.equal('estimated' in match, false);
  assert.equal(match.nextStep, 'Talk.');
});
