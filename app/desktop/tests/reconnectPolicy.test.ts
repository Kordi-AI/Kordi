import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createReconnectLoop, type ReconnectAttempt } from '../src/features/cloud/reconnectLoop';
import {
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_STABLE_OPEN_MS,
  createReconnectBackoff,
  reconnectDelayCeilingMs,
  reconnectDelayMs,
} from '../src/features/cloud/reconnectPolicy';

test('reconnect delays stay between zero and a ceiling that doubles from 1 s to 60 s', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 50].map(reconnectDelayCeilingMs),
    [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000],
  );
  for (const attempt of [0, 3, 6, 1_000, -2, Number.NaN]) {
    for (const sample of [0, 0.25, 0.999_999, 1, -1, 7, Number.NaN]) {
      const delay = reconnectDelayMs(attempt, () => sample);
      assert.ok(delay >= 0 && delay <= RECONNECT_MAX_DELAY_MS, `attempt ${attempt}, sample ${sample}: ${delay}`);
      assert.ok(delay <= reconnectDelayCeilingMs(attempt));
    }
  }
});

test('reconnect jitter comes from the random source, so clients spread out', () => {
  assert.equal(reconnectDelayMs(3, () => 0), 0);
  assert.equal(reconnectDelayMs(3, () => 0.5), 4_000);
  assert.equal(reconnectDelayMs(3, () => 0.25), 2_000);
  const samples = [0.1, 0.9, 0.4];
  const delays = samples.map((sample) => reconnectDelayMs(10, () => sample));
  assert.deepEqual(delays, [6_000, 54_000, 24_000]);
});

test('the attempt count starts over only after a socket stayed open for 30 s', () => {
  let now = 0;
  const backoff = createReconnectBackoff({ now: () => now, random: () => 1 });
  assert.equal(backoff.nextDelayMs(), 1_000);
  assert.equal(backoff.nextDelayMs(), 2_000);
  // The server closes right after the handshake: no reset, the wait keeps growing.
  backoff.opened();
  now += 50;
  backoff.closed();
  assert.equal(backoff.attempt, 2);
  assert.equal(backoff.nextDelayMs(), 4_000);
  // Open just short of the threshold: still no reset.
  backoff.opened();
  now += RECONNECT_STABLE_OPEN_MS - 1;
  backoff.closed();
  assert.equal(backoff.nextDelayMs(), 8_000);
  // A failed attempt that never opened does not reset either.
  backoff.closed();
  assert.equal(backoff.nextDelayMs(), 16_000);
  // Open for the full threshold: the next wait starts from 1 s again.
  backoff.opened();
  now += RECONNECT_STABLE_OPEN_MS;
  backoff.closed();
  assert.equal(backoff.attempt, 0);
  assert.equal(backoff.nextDelayMs(), 1_000);
});

function loopHarness() {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map<number, { callback: () => void; ms: number }>();
  const network = new EventTarget();
  const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  const attempts: ReconnectAttempt[] = [];
  let resumes = 0;
  const loop = createReconnectLoop({
    connect: (attempt) => { attempts.push(attempt); },
    onResume: () => { resumes += 1; },
    now: () => now,
    random: () => 1,
    setTimer: (callback, ms) => { timers.set(++nextTimer, { callback, ms }); return nextTimer; },
    clearTimer: (timer) => { timers.delete(timer as number); },
    networkTarget: network,
    visibilityTarget: visibility,
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const fire = async () => {
    const [[id, timer]] = [...timers];
    timers.delete(id);
    timer.callback();
    await settle();
  };
  return {
    loop, attempts, timers, network, visibility, settle, fire,
    advance(ms: number) { now += ms; },
    resumes: () => resumes,
  };
}

test('a closed socket waits with backoff, and the network returning reconnects at once', async () => {
  const harness = loopHarness();
  harness.loop.start();
  await harness.settle();
  assert.equal(harness.attempts.length, 1);
  harness.attempts[0].opened();
  harness.attempts[0].closed();
  assert.deepEqual([...harness.timers.values()].map((timer) => timer.ms), [1_000]);
  await harness.fire();
  harness.attempts[1].closed();
  assert.deepEqual([...harness.timers.values()].map((timer) => timer.ms), [2_000]);

  harness.network.dispatchEvent(new Event('online'));
  await harness.settle();
  assert.equal(harness.timers.size, 0, 'the waiting timer is replaced by an attempt now');
  assert.equal(harness.attempts.length, 3);
  // A second signal while that attempt is in flight does not stack another one.
  harness.network.dispatchEvent(new Event('online'));
  harness.visibility.dispatchEvent(new Event('visibilitychange'));
  await harness.settle();
  assert.equal(harness.attempts.length, 3);
  assert.equal(harness.loop.phase, 'connecting');

  // A stale attempt cannot schedule anything.
  harness.attempts[1].closed();
  assert.equal(harness.timers.size, 0);

  harness.attempts[2].opened();
  harness.network.dispatchEvent(new Event('online'));
  await harness.settle();
  assert.equal(harness.attempts.length, 3, 'an open socket is not replaced');
  assert.equal(harness.resumes(), 1, 'an open socket is asked to prove it is alive');
  harness.loop.stop();
  harness.attempts[2].closed();
  assert.equal(harness.timers.size, 0);
});

test('a window shown after being hidden reconnects at once; a hidden one keeps waiting', async () => {
  const harness = loopHarness();
  harness.loop.start();
  await harness.settle();
  harness.attempts[0].closed();
  assert.equal(harness.timers.size, 1);
  harness.visibility.visibilityState = 'hidden';
  harness.visibility.dispatchEvent(new Event('visibilitychange'));
  await harness.settle();
  assert.equal(harness.attempts.length, 1);
  harness.visibility.visibilityState = 'visible';
  harness.visibility.dispatchEvent(new Event('visibilitychange'));
  await harness.settle();
  assert.equal(harness.attempts.length, 2);
  assert.equal(harness.timers.size, 0);
});

test('a failing connect counts as a closed attempt, and an idle loop waits for a signal', async () => {
  let now = 0;
  const delays: number[] = [];
  const errors: unknown[] = [];
  const network = new EventTarget();
  let calls = 0;
  let pending: (() => void) | null = null;
  const loop = createReconnectLoop({
    connect: (attempt) => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      if (calls === 2) attempt.idle();
    },
    onError: (error) => errors.push(error),
    now: () => now,
    random: () => 1,
    setTimer: (callback, ms) => { delays.push(ms); pending = callback; return 1; },
    clearTimer: () => { pending = null; },
    networkTarget: network,
    visibilityTarget: null,
  });
  loop.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.deepEqual(delays, [1_000]);
  now += 1_000;
  (pending as (() => void) | null)?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(loop.phase, 'idle');
  assert.deepEqual(delays, [1_000], 'idle schedules nothing');
  network.dispatchEvent(new Event('online'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
  loop.stop();
  network.dispatchEvent(new Event('online'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 3, 'a stopped loop ignores signals');
});
