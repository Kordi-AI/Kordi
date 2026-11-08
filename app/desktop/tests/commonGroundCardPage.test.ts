import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { cardAnchor, cardTimeline } from '../src/features/commonGround/cardReferences';
import { CardScreen } from '../src/features/commonGround/CardScreen';
import { CommonGroundStore } from '../src/features/commonGround/store';
import type { CgOwnCard } from '../src/features/commonGround/types';

import { card, mockServer, owner, profile } from './helpers/commonGroundServer';

const work = profile('cgp_work', 'work', 'Work', true);
const diary = 'User is running a 3-month diary study on how people use agents at work, with weekly check-ins and a closing interview for every participant in the group.';

const withProfile = (patch: Partial<CgOwnCard>, cardProfile: CgOwnCard['profile']): CgOwnCard => ({ ...card, ...patch, profile: cardProfile });

function render(ownCard: CgOwnCard) {
  const store = new CommonGroundStore(mockServer({}).client, { profiles: true });
  store.set({ profiles: [work], profileId: 'cgp_work', owner: owner({ card: ownCard }) });
  return renderToStaticMarkup(createElement(CardScreen, { state: store.getSnapshot(), store }));
}

const refsCard = withProfile({ workingOn: ['Agent memory', 'Diary study'], interests: ['User research'] }, {
  topics: {
    'Agent memory': { refs: ['e1', 'e2'], firstSeen: '2026-10-03', lastSeen: '2026-10-12' },
    'Diary study': { refs: ['e1'], firstSeen: '2026-10-03', lastSeen: '2026-10-03' },
    'User research': { refs: ['e1'], firstSeen: '2026-10-03', lastSeen: '2026-10-03' },
  },
  evidence: {
    e1: { source: 'Notes', title: 'Your notes', date: '2026-10-12', url: null, snippet: diary },
    e2: { source: 'GitHub', title: 'memory-bench #7', date: '2026-10-03', url: 'https://github.com/example/memory-bench/pull/7', snippet: 'Adds an episodic store.' },
  },
});

const chip = (label: string) => new RegExp(`<button type="button" class="cg-ref-chip" title="${label}" aria-expanded="false"><svg[^>]*cg-ref-glyph[^>]*>.*?</svg><span>${label}</span></button>`);

test('card page: references are chips; a note uses its own words, not a generic title', () => {
  const html = render(refsCard);
  assert.doesNotMatch(html, /Your notes/);
  assert.match(html, chip(diary));
  assert.match(html, chip('memory-bench #7'));
  // Nothing is open until a chip is clicked, and no raw quote sits on the page.
  assert.doesNotMatch(html, /cg-ref-detail/);
  assert.doesNotMatch(html, /Adds an episodic store/);
});

test('card page: evidence cited again shows the same chip, with no "Same reference as" rows', () => {
  const html = render(refsCard);
  assert.doesNotMatch(html, /Same (note|reference) as/);
  assert.equal(html.split(`<span>${diary}</span>`).length - 1, 3);
});

const timelineCard = withProfile({ workingOn: ['Agent memory', 'Eval design'], interests: ['Speech'] }, {
  latest: ['Agent memory', 'Eval design'],
  earlier: ['Speech', 'Robotics'],
  timeline: [
    { period: '2026 Q4', topics: ['Eval design'] },
    { period: '2026 Q3', topics: ['Agent memory', 'Eval design'] },
    { period: '2026 Q1', topics: ['Speech'] },
  ],
});

test('card page: the timeline lists periods newest first, each topic once, earlier topics muted at the end', () => {
  const { now, rows } = cardTimeline(timelineCard);
  assert.deepEqual(now, ['Agent memory', 'Eval design']);
  assert.deepEqual(rows, [
    { period: '2026 Q3', topics: ['Agent memory', 'Eval design'], muted: false },
    { period: '2026 Q1', topics: ['Speech'], muted: true },
    { period: 'Earlier', topics: ['Robotics'], muted: true },
  ]);
  const html = render(timelineCard);
  const now0 = html.indexOf('>Now</h3>');
  const topics = html.indexOf('>Working on</h3>');
  const timeline = html.indexOf('>Timeline</h3>');
  assert.ok(now0 > 0 && now0 < topics && topics < timeline);
  assert.ok(html.indexOf('>2026 Q3<') < html.indexOf('>2026 Q1<') && html.indexOf('>2026 Q1<') < html.indexOf('>Earlier<'));
  assert.doesNotMatch(html, />2026 Q4</);
  assert.match(html, /<li class="cg-tl-row is-muted"><span class="cg-tl-period">Earlier<\/span>/);
  // Chips for topics on the card scroll to them; others only read.
  assert.match(html, /<button type="button" class="cg-chip is-link" aria-label="Go to Agent memory">/);
  assert.match(html, /<span class="cg-chip"><span class="cg-tag tone-\w+ is-muted is-small"><i aria-hidden="true"><\/i><span class="cg-tag-text" title="Robotics">/);
  assert.match(html, new RegExp(`id="${cardAnchor('topic', 'Agent memory')}"`));
});

test('card page: no timeline or Now when the server sends none', () => {
  const html = render(withProfile({}, { latest: [], earlier: [], timeline: [] }));
  assert.doesNotMatch(html, /cg-timeline|>Timeline<|>Now</);
  assert.deepEqual(cardTimeline(withProfile({}, null)).rows, []);
});
