import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';

import { Screen, buttonNamed, click, deviceAnswers, fresh, mount, people, settings, storeWith } from './helpers/nearbyScreen';

// Grounding › Nearby on this device: the screen sends a location by itself while it is open.

test('nearby screen: opening it with sharing on sends this device\'s location by itself, then shows results', async () => {
  const { store, calls } = storeWith({
    'GET nearby': [{ status: 200, body: settings({ location: null }) }, { status: 200, body: settings() }],
    'GET nearby/needs': { status: 200, body: { needs: [] } },
    'GET nearby/people': { status: 200, body: people },
    'POST nearby/location': { status: 200, body: { location: fresh() } },
  });
  const device = deviceAnswers(store);
  await mount(createElement(Screen, { store }), async (root) => {
    assert.equal(device.requests(), 1);
    assert.equal(calls.filter((call) => call.url.endsWith('/nearby/location')).length, 1);
    assert.match(root.textContent ?? '', /Maya Chen/);
    assert.doesNotMatch(root.textContent ?? '', /No results yet/);
    assert.ok(buttonNamed(root, 'Use this device’s location'), 'the manual link stays');
  });
});

test('nearby screen: paused or off never asks for this device\'s location', async () => {
  for (const patch of [{ pausedUntil: new Date(Date.now() + 60 * 60_000).toISOString() }, { enabled: false, participating: false }]) {
    const { store, calls } = storeWith({
      'GET nearby': { status: 200, body: settings({ location: null, ...patch }) },
      'GET nearby/needs': { status: 200, body: { needs: [] } },
    });
    const device = deviceAnswers(store);
    await mount(createElement(Screen, { store }), async () => {
      assert.equal(device.requests(), 0);
      assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
    });
  }
});

test('nearby screen: Refresh results also sends a new location, at most once a minute', async () => {
  const { store, calls } = storeWith({
    'GET nearby': { status: 200, body: settings({ location: null }) },
    'GET nearby/needs': { status: 200, body: { needs: [] } },
    'POST nearby/location': { status: 200, body: { location: fresh() } },
  });
  const device = deviceAnswers(store, false);
  await mount(createElement(Screen, { store }), async (root) => {
    assert.equal(device.requests(), 0);
    device.device.available = true;
    await click(buttonNamed(root, 'Refresh results'));
    assert.equal(device.requests(), 1);
    assert.equal(calls.filter((call) => call.url.endsWith('/nearby/location')).length, 1);
    await click(buttonNamed(root, 'Refresh results'));
    assert.equal(device.requests(), 1, 'throttled');
  });
});

test('nearby screen: the empty People state offers the location update', async () => {
  const { store, calls } = storeWith({
    'GET nearby': [{ status: 200, body: settings({ location: null }) }, { status: 200, body: settings() }],
    'GET nearby/needs': { status: 200, body: { needs: [] } },
    'GET nearby/people': { status: 200, body: people },
    'POST nearby/location': { status: 200, body: { location: fresh() } },
  });
  const device = deviceAnswers(store, false);
  await mount(createElement(Screen, { store }), async (root) => {
    assert.match(root.textContent ?? '', /No results yet/);
    await click(buttonNamed(root, 'Update location'));
    assert.equal(device.requests(), 1);
    assert.equal(calls.filter((call) => call.url.endsWith('/nearby/location')).length, 1);
    assert.match(root.textContent ?? '', /Maya Chen/);
  });
});
