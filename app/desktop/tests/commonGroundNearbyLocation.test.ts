import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import { NearbyLocationError, nearbyLocationInput, nearbyNativeLocationError } from '../src/features/commonGround/nearbyLocationFix';
import {
  NEARBY_LOCATE_EVERY_MS, NEARBY_LOCATE_MIN_MS, NearbyLocator, startNearbyLocating, type NearbyLocatorHost,
} from '../src/features/commonGround/nearbyLocator';

test('nearby device location rejects stale, inaccurate, and invalid fixes before transmission', () => {
  const now = Date.now();
  const valid = { latitude: 40, longitude: -75, accuracy: 100, timestamp: now };
  for (const patch of [{ latitude: NaN }, { longitude: 181 }, { accuracy: -1 }, { accuracy: 2001 }, { timestamp: now - 600_001 }, { timestamp: now + 60_001 }]) {
    assert.throws(() => nearbyLocationInput({ ...valid, ...patch }, now));
  }
  assert.equal(nearbyLocationInput(valid, now).capturedAt, new Date(now).toISOString());
});


test('native Nearby location ships the signed entitlement and usage description needed for the permission prompt', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  assert.equal(config.bundle.macOS.entitlements, './Entitlements.plist');
  const entitlements = readFileSync(new URL('../src-tauri/Entitlements.plist', import.meta.url), 'utf8');
  assert.match(entitlements, /<key>com\.apple\.security\.personal-information\.location<\/key>\s*<true\s*\/>/);
  const info = readFileSync(new URL('../src-tauri/Info.plist', import.meta.url), 'utf8');
  assert.match(info, /<key>NSLocationUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
});

test('native location failures map to copy, with Location Services only for permission problems', () => {
  const denied = nearbyNativeLocationError(new Error('location_denied'));
  assert.ok(denied instanceof NearbyLocationError);
  assert.equal(denied.message, 'Allow Kordi in Location Services, then try again.');
  assert.equal(denied.settings, true);
  for (const code of ['location_services_off', 'location_permission_pending']) {
    assert.equal((nearbyNativeLocationError(new Error(code)) as NearbyLocationError).settings, true);
  }
  for (const code of ['location_timeout', 'location_unavailable', 'location_busy', 'location_not_bundled']) {
    const error = nearbyNativeLocationError(new Error(code));
    assert.ok(error instanceof NearbyLocationError);
    assert.equal(error.settings, false);
    assert.equal(error.blocked, code === 'location_not_bundled', 'only a build that cannot ask stops automatic requests');
    assert.doesNotMatch(error.message, /location_/);
  }
  assert.equal(denied.blocked, true);
  const other = new Error('Network failed.');
  assert.equal(nearbyNativeLocationError(other), other);
});

test('native location asks for permission before reading a fix and never treats an unanswered prompt as a fix failure', () => {
  const source = readFileSync(new URL('../src-tauri/src/nearby_location/macos.rs', import.meta.url), 'utf8');
  assert.match(source, /requestWhenInUseAuthorization\(\)/);
  assert.doesNotMatch(source, /requestLocation\(\)/);
  assert.match(source, /bundleIdentifier\(\)/);
});

type Phase = ReturnType<NearbyLocatorHost['phase']>;

/** A locator over a fake Nearby store, clock and device. */
function locatorWith(options: { phase?: Phase; fail?: () => Error } = {}) {
  const posts: unknown[] = [];
  let refreshes = 0;
  let requests = 0;
  const world: { phase: Phase; now: number; hidden: boolean; fail?: () => Error } = { phase: options.phase ?? 'no-phone', now: 1_000_000, hidden: false, fail: options.fail };
  const host: NearbyLocatorHost = {
    host: { client: { postNearbyLocation: async (fix) => { posts.push(fix); return { location: { capturedAt: '', freshUntil: '', fresh: true } }; } } },
    phase: () => world.phase,
    refresh: async () => { refreshes += 1; },
  };
  const locator = new NearbyLocator(host, {
    available: () => true,
    hidden: () => world.hidden,
    now: () => world.now,
    locate: async () => {
      requests += 1;
      if (world.fail) throw world.fail();
      return { latitude: 40.1, longitude: -75.6, accuracy: 50, capturedAt: new Date(world.now).toISOString() };
    },
  });
  return { locator, world, posts, counts: () => ({ requests, refreshes }) };
}

test('nearby locator: asks only while a screen is open, visible, and Nearby is on and not paused', async () => {
  const { locator, world, posts, counts } = locatorWith();
  await locator.auto();
  assert.equal(counts().requests, 0, 'no screen open');
  const detach = locator.attach();
  for (const phase of ['off', 'paused'] as Phase[]) {
    world.phase = phase;
    await locator.auto();
  }
  world.phase = 'on';
  world.hidden = true;
  await locator.auto();
  assert.equal(counts().requests, 0, 'off, paused and hidden never ask');
  world.hidden = false;
  await locator.auto();
  assert.deepEqual(counts(), { requests: 1, refreshes: 1 });
  assert.equal(posts.length, 1);
  detach();
  world.now += NEARBY_LOCATE_EVERY_MS;
  await locator.auto();
  assert.equal(counts().requests, 1, 'closing the screen stops automatic requests');
});

test('nearby locator: one request at a time and at most one automatic request a minute', async () => {
  const { locator, world, counts } = locatorWith();
  locator.attach();
  await Promise.all([locator.auto(), locator.auto(), locator.locate()]);
  assert.equal(counts().requests, 1, 'concurrent triggers share the running request');
  assert.equal(locator.getSnapshot().busy, false);
  world.now += NEARBY_LOCATE_MIN_MS - 1;
  await locator.auto();
  assert.equal(counts().requests, 1);
  await locator.auto(NEARBY_LOCATE_EVERY_MS);
  assert.equal(counts().requests, 1);
  world.now += 1;
  await locator.auto();
  assert.equal(counts().requests, 2, 'Refresh or resuming asks again after a minute');
  world.now += NEARBY_LOCATE_MIN_MS;
  await locator.auto(NEARBY_LOCATE_EVERY_MS);
  assert.equal(counts().requests, 2, 'the timer waits 5 minutes');
  world.now += NEARBY_LOCATE_EVERY_MS;
  await locator.auto(NEARBY_LOCATE_EVERY_MS);
  assert.equal(counts().requests, 3);
});

test('nearby locator: an automatic denial stays quiet while another device has a fresh location', async () => {
  const { locator, world, counts } = locatorWith({ phase: 'on', fail: () => nearbyNativeLocationError(new Error('location_denied')) });
  locator.attach();
  await locator.auto();
  assert.deepEqual(locator.getSnapshot(), { busy: false, notice: null, settings: false, blocked: true });
  world.now += NEARBY_LOCATE_EVERY_MS * 3;
  await locator.auto(NEARBY_LOCATE_EVERY_MS);
  assert.equal(counts().requests, 1, 'automatic requests still stop');
  await locator.locate();
  assert.equal(locator.getSnapshot().notice, 'Allow Kordi in Location Services, then try again.', 'a manual request still explains');
});

test('nearby locator: a denied permission stops automatic requests until a manual one succeeds', async () => {
  const { locator, world, posts, counts } = locatorWith({ fail: () => nearbyNativeLocationError(new Error('location_denied')) });
  locator.attach();
  await locator.auto();
  assert.deepEqual(locator.getSnapshot(), { busy: false, notice: 'Allow Kordi in Location Services, then try again.', settings: true, blocked: true });
  world.now += NEARBY_LOCATE_EVERY_MS * 3;
  await locator.auto();
  await locator.auto(NEARBY_LOCATE_EVERY_MS);
  assert.equal(counts().requests, 1, 'no repeated prompts or errors');
  world.fail = undefined;
  await locator.locate();
  assert.equal(posts.length, 1);
  assert.deepEqual(locator.getSnapshot(), { busy: false, notice: null, settings: false, blocked: false });
  world.now += NEARBY_LOCATE_MIN_MS;
  await locator.auto();
  assert.equal(counts().requests, 3, 'automatic requests resume');
});

test('nearby locator: a passing automatic failure stays quiet; a manual one shows its line', async () => {
  const { locator, posts } = locatorWith({ fail: () => nearbyNativeLocationError(new Error('location_timeout')) });
  locator.attach();
  await locator.auto();
  assert.deepEqual(locator.getSnapshot(), { busy: false, notice: null, settings: false, blocked: false });
  await locator.locate();
  assert.equal(locator.getSnapshot().notice, 'Could not find your location. Check Wi-Fi, then try again.');
  assert.equal(locator.getSnapshot().blocked, false);
  assert.equal(posts.length, 0);
});

test('nearby locator: a fix that lands after pausing is not posted', async () => {
  const { locator, world, posts } = locatorWith();
  locator.attach();
  const pending = locator.auto();
  world.phase = 'paused';
  await pending;
  assert.equal(posts.length, 0);
});

test('nearby locating: the open screen sends a new fix every 5 minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { locator, world, counts } = locatorWith({ phase: 'on' });
  locator.attach();
  await locator.auto();
  const stop = startNearbyLocating(locator);
  const advance = async (ms: number) => {
    world.now += ms;
    t.mock.timers.tick(ms);
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  };
  for (let step = 0; step < 19; step += 1) await advance(15_000);
  assert.equal(counts().requests, 1, 'not before 5 minutes');
  await advance(15_000);
  assert.equal(counts().requests, 2);
  stop();
  await advance(NEARBY_LOCATE_EVERY_MS);
  assert.equal(counts().requests, 2, 'stops with the screen');
});
