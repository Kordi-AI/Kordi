import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { act, createElement } from 'react';

import { CommonGroundPage } from '../src/features/commonGround/CommonGroundPage';
import type { CgHost } from '../src/features/commonGround/host';
import { CommonGroundStore } from '../src/features/commonGround/store';
import { requestHelpGrounding } from '../src/features/onboarding/helpNavigation';
import { setHelpTourLocation, type TourLocation } from '../src/features/onboarding/helpTourSession';

import { mockServer, owner, profile } from './helpers/commonGroundServer';
import { installDom } from './helpers/transcriptAttachmentDom';

const work = profile('cgp_work', 'work', 'Work', true);
const host: CgHost = {
  self: { accountId: 'acct_you', name: 'Alex Kim', avatarUrl: null }, profiles: true, sources: true, memoryAvailable: false,
  openChat: () => undefined, acceptRequest: async () => undefined, contactsChanged: () => undefined, openGroup: () => undefined,
  connectors: null, agentFiles: null, device: null, openUrl: () => undefined,
};

const settle = () => act(async () => { for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });

/** The account's own page during a tour step; the store answers only what the page loads itself. */
async function onStep(withCard: boolean, run: (root: HTMLElement, store: CommonGroundStore, go: (location: TourLocation) => Promise<void>, calls: Array<{ method: string }>) => Promise<void>) {
  const installed = installDom();
  const unexpected: string[] = [];
  const realFetch = globalThis.fetch;
  const realEvent = globalThis.Event;
  globalThis.Event = installed.dom.window.Event as unknown as typeof Event;
  globalThis.fetch = (async (input: RequestInfo | URL) => { unexpected.push(String(input)); return new Response('', { status: 404 }); }) as typeof fetch;
  const { client, calls } = mockServer({ 'GET rooms': { status: 200, body: { rooms: [] } }, 'GET recent': { status: 200, body: { people: [] } } });
  const store = new CommonGroundStore(client, { profiles: true });
  store.set({ loaded: true, profiles: [{ ...work, hasCard: withCard }], profileId: work.profileId, owner: owner(withCard ? { profile: work } : { card: null, profile: work }) });
  const { createRoot } = await import('react-dom/client');
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  const go = async (location: TourLocation) => {
    await act(async () => {
      setHelpTourLocation(location);
      if (location.groundingScreen) requestHelpGrounding(host.self.accountId, location.groundingScreen);
    });
    await settle();
  };
  try {
    await act(async () => root.render(createElement(CommonGroundPage, { store, host })));
    await settle();
    await run(node, store, go, calls);
    assert.deepEqual(unexpected, [], 'the example never reaches the network');
  } finally {
    await act(async () => { setHelpTourLocation(null); root.unmount(); });
    globalThis.fetch = realFetch;
    globalThis.Event = realEvent;
    installed.restore();
  }
}

const target = (root: ParentNode, name: string) => root.querySelector(`[data-help-target="${name}"]`);
const selectedTab = (root: ParentNode) => root.querySelector('[role="tab"][aria-selected="true"]')?.textContent;

for (const withCard of [true, false]) {
  test(`the tour room is always an example room and never moves the account's page (${withCard ? 'with' : 'without'} a card)`, async () => {
    await onStep(withCard, async (root, store, go, calls) => {
      await go({ target: 'grounding-room-people', groundingScreen: 'room' });
      const demo = root.querySelector('[data-help-demo="grounding"]');
      assert.ok(demo, 'the example replaces the page');
      assert.match(demo.textContent ?? '', /Example data/);
      assert.ok(demo.querySelector('fieldset[disabled]'), 'example controls stay disabled');
      const people = target(root, 'grounding-room-people');
      assert.ok(people && target(root, 'grounding-room-topics'));
      assert.equal(people.querySelectorAll('button.cg-row').length, 5);
      assert.match(people.textContent ?? '', /86%/);
      assert.match(demo.textContent ?? '', /Suggested/);
      await go({ target: 'grounding-room-topics', groundingScreen: 'room' });
      const topics = target(root, 'grounding-room-people');
      assert.equal(topics?.querySelectorAll('button[aria-label^="Start a group for"]').length, 3, 'Topics shows Start on each shared topic');
      const logged = mock.method(globalThis.console, 'error', () => undefined);
      try {
        await go({ target: 'grounding-room-gallery', groundingScreen: 'room' });
        assert.equal(selectedTab(root), 'Gallery', 'the Gallery step opens the Gallery tab');
        const grid = target(root, 'grounding-room-gallery');
        assert.equal(grid?.querySelectorAll('[data-cg-gallery-item]').length, 4, 'the example Gallery keeps its items after it loads');
        for (const title of ['Screen reader design notes', 'Demo script', 'Model latency by device', 'Usability study tasks']) assert.match(grid?.textContent ?? '', new RegExp(title));
        await go({ target: 'grounding-room-gallery-share', groundingScreen: 'room' });
        const share = target(root, 'grounding-room-gallery-share');
        assert.equal(share?.textContent, 'Share');
        assert.ok(share?.closest('fieldset[disabled]'), 'Share stays an example control');
        assert.equal(selectedTab(root), 'Gallery');
        assert.equal(root.querySelector('[role="alert"]'), null, 'the example Gallery shows no error');
        // Going back opens each step's own list again.
        await go({ target: 'grounding-room-gallery', groundingScreen: 'room' });
        assert.equal(selectedTab(root), 'Gallery');
        await go({ target: 'grounding-room-topics', groundingScreen: 'room' });
        assert.equal(selectedTab(root), 'Topics');
        assert.equal(target(root, 'grounding-room-gallery'), null);
        await go({ target: 'grounding-room-people', groundingScreen: 'room' });
        assert.equal(selectedTab(root), 'People');
      } finally {
        logged.mock.restore();
      }
      assert.deepEqual(logged.mock.calls.map((call) => call.arguments), [], 'the example Gallery logs no errors');
      assert.deepEqual(store.getSnapshot().stack, [{ name: 'home' }], 'the account page never opens a room screen');
      assert.deepEqual(store.getSnapshot().gallery, { lists: {}, candidates: {}, items: {}, tabs: {} }, 'the account store never holds the example Gallery');
      assert.deepEqual(calls.filter((call) => call.method !== 'GET' || call.url.includes('/gallery')), [], 'nothing is written to the account');
      await go({ target: 'help' });
      assert.equal(root.querySelector('[data-help-demo]'), null, 'the example leaves with the tour step');
    });
  });
}

test('the example Build screen shows every source group for the tour', async () => {
  await onStep(false, async (root, _store, go, calls) => {
    await go({ target: 'grounding-connectors', groundingScreen: 'build' });
    assert.ok(root.querySelector('[data-help-demo="grounding"]'));
    for (const name of ['grounding-memory', 'grounding-documents', 'grounding-connectors', 'grounding-device', 'grounding-links', 'grounding-notes', 'grounding-build']) assert.ok(target(root, name), name);
    const connectors = target(root, 'grounding-connectors');
    assert.equal(connectors?.querySelectorAll('button[aria-label^="Set up"]').length, 4, 'every account shows as not connected');
    const device = target(root, 'grounding-device')?.textContent ?? '';
    for (const name of ['Calendar', 'Reminders', 'Agents', 'AGENTS.md']) assert.match(device, new RegExp(name));
    assert.deepEqual(calls.filter((call) => call.method !== 'GET'), []);
  });
});
