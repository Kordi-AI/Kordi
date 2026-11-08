import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { cardAnchor, cardTimeline, firstCiters } from '../src/features/commonGround/cardReferences';
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

test('card page: a note shows its own words with no icon tile and no generic title', () => {
  const html = render(refsCard);
  assert.doesNotMatch(html, /cg-ref-icon/);
  assert.doesNotMatch(html, /Your notes/);
  assert.match(html, new RegExp(`<q class="cg-ref-quote is-folded">${diary}</q>`));
  assert.match(html, /<button type="button" class="cg-ref-more" aria-expanded="false">Show more<\/button>/);
  // Notes carry no glyph; the line is just the source and the day.
  assert.match(html, /<span class="cg-ref-meta"><span>Notes · 12 Oct<\/span><\/span>/);
});

test('card page: other sources get a 12px glyph, and a URL makes the title a link', () => {
  const html = render(refsCard);
  assert.match(html, /<q class="cg-ref-quote">Adds an episodic store\.<\/q>/);
  assert.match(html, /<span class="cg-ref-meta"><svg[^>]*class="lucide[^"]*cg-ref-glyph"/);
  assert.match(html, /<a class="cg-ref-link" href="https:\/\/github\.com\/example\/memory-bench\/pull\/7"[^>]*target="_blank"[^>]*>memory-bench #7/);
  assert.match(html, /GitHub · 3 Oct/);
});

test('card page: evidence cited again shows only where it came from, never a "Same reference as" row', () => {
  const html = render(refsCard);
  assert.equal(html.split(diary).length - 1, 1);
  assert.equal(html.split(`id="${cardAnchor('ref', 'e1')}"`).length - 1, 1);
  assert.doesNotMatch(html, /Same (note|reference) as|cg-ref-same/);
  // The two later topics each show the note's source line instead.
  assert.equal(html.split('<div class="cg-ref-sources"><span class="cg-ref-meta"><span>Notes · 12 Oct</span></span></div>').length - 1, 2);
  assert.deepEqual([...firstCiters(refsCard).values()], ['Agent memory', 'Agent memory']);
});

const scholar = 'https://scholar.google.com/citations?user=abc';
const linksCard = withProfile({ workingOn: ['AI agent evaluation', 'Multi-agent collaboration'] }, {
  topics: {
    'AI agent evaluation': { refs: ['e1', 'e2'], firstSeen: '2026-11-01', lastSeen: '2026-11-01' },
    'Multi-agent collaboration': { refs: ['e1', 'e2', 'e3'], firstSeen: '2026-11-01', lastSeen: '2026-11-01' },
  },
  evidence: {
    e1: { source: 'Link', title: 'Jane Doe - Google Scholar', date: '2026-11-01', url: scholar, snippet: 'Jane Doe · Research interests: multi-agent systems' },
    // The same page given twice is one source.
    e2: { source: 'Link', title: 'Jane Doe - Google Scholar', date: '2026-11-01', url: `${scholar}/`, snippet: 'Jane Doe · Research interests: multi-agent systems' },
    e3: { source: 'Link', title: 'Lab page', date: '2026-11-01', url: 'https://lab.example.test/', snippet: 'Our lab studies how teams of agents cooperate.' },
  },
});

test('card page: a link cited again is just a link to its source, each source once', () => {
  const html = render(linksCard);
  assert.doesNotMatch(html, /Same (note|reference) as/);
  assert.equal(html.split('Jane Doe · Research interests').length - 1, 1, 'the page text shows once');
  const links = html.match(/<a class="cg-ref-link" href="https:\/\/scholar\.google\.com\/citations\?user=abc"/g) ?? [];
  assert.equal(links.length, 2, 'once in full, once as a link under the later topic');
  assert.match(html, /<div class="cg-ref-sources"><span class="cg-ref-meta"><svg[\s\S]*?<\/svg><a class="cg-ref-link" href="https:\/\/scholar\.google\.com\/citations\?user=abc"[^>]*>Jane Doe - Google Scholar/);
  assert.match(html, /Our lab studies how teams of agents cooperate\./);
});

test('card page: a link the build could not read says so under Sources', () => {
  const store = new CommonGroundStore(mockServer({}).client, { profiles: true });
  const unreadLinks = [{ url: scholar, reason: 'blocked' }];
  store.set({ profiles: [work], profileId: 'cgp_work', owner: owner({ card: linksCard, build: { status: 'idle', errorCode: null, unreadLinks } }) });
  const html = renderToStaticMarkup(createElement(CardScreen, { state: store.getSnapshot(), store }));
  assert.match(html, /<ul class="cg-unread-links"><li title="https:\/\/scholar\.google\.com\/citations\?user=abc">Couldn&#x27;t read scholar\.google\.com<\/li><\/ul>/);
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
