import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';

import type { CloudAccount, CloudAuthClient } from '../src/features/cloud/authClient';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { CLOUD_REALTIME_PROBE_ACK_MS, useCloudRealtimeMessages } from '../src/features/cloud/useCloudRealtimeMessages';
import { waitForReactCondition } from './helpers/waitForReactCondition';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(body: string) { this.sent.push(JSON.parse(body)); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  open() { this.readyState = 1; this.onopen?.(); }
  frame(value: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(value) }); }
  hello() { this.open(); this.frame({ type: 'hello', heartbeat_interval_ms: 30_000 }); }
}

/** Mounts the chat socket against fake timers, a fake socket and a scripted catch-up. */
async function mountRealtime(context: TestContext, catchUp: () => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    WebSocket: globalThis.WebSocket,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, WebSocket: FakeSocket });
  FakeSocket.instances = [];
  let now = 0;
  context.mock.method(Date, 'now', () => now);
  context.mock.method(Math, 'random', () => 0.5);
  let nextTimer = 0;
  const timeouts = new Map<number, { callback: () => void; ms: number }>();
  const intervals = new Map<number, { callback: () => void; ms: number }>();
  context.mock.method(window, 'setTimeout', (callback: () => void, ms: number) => { timeouts.set(++nextTimer, { callback, ms }); return nextTimer; });
  context.mock.method(window, 'clearTimeout', (id: number) => { timeouts.delete(id); });
  context.mock.method(window, 'setInterval', (callback: () => void, ms: number) => { intervals.set(++nextTimer, { callback, ms }); return nextTimer; });
  context.mock.method(window, 'clearInterval', (id: number) => { intervals.delete(id); });
  let appliedSeq = 1;
  let cursorReads = 0;
  mockIPC((command) => {
    assert.equal(command, 'desktop_chat_sync_cursor');
    cursorReads += 1;
    return { accountId: 'acct_owner', cursor: `saved-cursor-${appliedSeq}`, lastStreamSeq: appliedSeq };
  });
  __setSessionBackendForTests({
    load: async () => ({ token: 'synthetic-token', accountId: 'acct_owner', expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => {},
    clear: async () => {},
  });
  let tickets = 0;
  const warnings: unknown[] = [];
  const client = {
    issueChatSyncRealtimeTicket: async () => { tickets += 1; return { ticket: `ticket-${tickets}`, device_id: 'device-1' }; },
  } as unknown as CloudAuthClient;
  const connected: boolean[] = [];
  function Harness() {
    useCloudRealtimeMessages({
      account: { accountId: 'acct_owner', displayName: 'Owner' } as CloudAccount,
      client,
      mergeMessage: () => {},
      syncCloudCollaborationDiff: catchUp,
      setRealtimeConnected: (value) => { connected.push(value); },
      reportWarning: (_message, error) => { warnings.push(error); },
    });
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(createElement(Harness)));
  let unmounted = false;
  // Pending reconnect waits; the jittered first heartbeat (15 s here) is not one.
  const reconnectDelays = () => [...timeouts.values()].map((timer) => timer.ms).filter((ms) => ms < 15_000);
  return {
    timeouts,
    intervals,
    warnings,
    connected,
    tickets: () => tickets,
    cursorReads: () => cursorReads,
    setApplied(value: number) { appliedSeq = value; },
    advance(ms: number) { now += ms; },
    reconnectDelays,
    async fireReconnect(ms: number) {
      const entry = [...timeouts].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `a reconnect timer of ${ms} ms is pending (pending: ${[...timeouts.values()].map((timer) => timer.ms).join(', ')})`);
      timeouts.delete(entry[0]);
      await act(async () => entry[1].callback());
    },
    async socket(count: number) {
      await waitForReactCondition(() => FakeSocket.instances.length === count, `socket ${count} opens`);
      return FakeSocket.instances[count - 1];
    },
    async dispatch(target: EventTarget, type: string) {
      await act(async () => { target.dispatchEvent(new dom.window.Event(type)); });
    },
    async unmount() {
      if (unmounted) return;
      unmounted = true;
      await act(async () => root.unmount());
    },
    async restore() {
      await this.unmount();
      clearMocks();
      __setSessionBackendForTests(null);
      Object.assign(globalThis, previous);
      dom.window.close();
    },
  };
}

test('a server that closes right after the handshake gets growing, jittered waits, not one retry a second', async (context) => {
  const harness = await mountRealtime(context, async () => {});
  try {
    const delays: number[] = [];
    for (let index = 1; index <= 4; index += 1) {
      const socket = await harness.socket(index);
      await act(async () => { socket.open(); socket.close(); });
      const [delay] = harness.reconnectDelays();
      delays.push(delay);
      harness.advance(delay);
      await harness.fireReconnect(delay);
    }
    // Half of each full-jitter window: 1 s, 2 s, 4 s, 8 s.
    assert.deepEqual(delays, [500, 1_000, 2_000, 4_000]);
    // A socket that then stays open for 30 s starts the count over.
    const steady = await harness.socket(5);
    await act(async () => steady.hello());
    harness.advance(30_000);
    await act(async () => steady.close());
    assert.deepEqual(harness.reconnectDelays(), [500]);
    await harness.unmount();
    assert.equal(harness.timeouts.size, 0);
    assert.equal(harness.intervals.size, 0);
  } finally {
    await harness.restore();
  }
});

test('the network coming back reconnects at once without stacking a second attempt', async (context) => {
  let holdCatchUp: (() => void) | null = null;
  let catchUps = 0;
  const harness = await mountRealtime(context, async () => {
    catchUps += 1;
    if (catchUps === 2) await new Promise<void>((resolve) => { holdCatchUp = resolve; });
  });
  try {
    const first = await harness.socket(1);
    await act(async () => { first.hello(); first.close(); });
    assert.deepEqual(harness.reconnectDelays(), [500]);
    await harness.dispatch(window, 'online');
    assert.deepEqual(harness.reconnectDelays(), [], 'the waiting timer gave way to an attempt now');
    await waitForReactCondition(() => holdCatchUp !== null, 'the attempt starts its catch-up');
    // More signals while that attempt is in flight change nothing.
    await harness.dispatch(window, 'online');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await harness.dispatch(document, 'visibilitychange');
    assert.equal(catchUps, 2);
    await act(async () => { (holdCatchUp as unknown as () => void)(); });
    const second = await harness.socket(2);
    assert.equal(harness.tickets(), 2);
    await act(async () => second.hello());
    assert.equal(second.sent[0]?.type, 'connect');
    assert.equal(second.sent[0]?.cursor, 'saved-cursor-1', 'the socket resumes from the saved cursor');
    assert.equal(FakeSocket.instances.length, 2);
  } finally {
    await harness.restore();
  }
});

test('a window shown again probes an open socket and replaces it when the ack never comes', async (context) => {
  const harness = await mountRealtime(context, async () => {});
  try {
    const socket = await harness.socket(1);
    await act(async () => socket.hello());
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await harness.dispatch(document, 'visibilitychange');
    assert.equal(socket.sent.at(-1)?.type, 'heartbeat');
    const probe = [...harness.timeouts].find(([, timer]) => timer.ms === CLOUD_REALTIME_PROBE_ACK_MS);
    assert.ok(probe, 'the probe waits a short time for its ack');
    await act(async () => socket.frame({ type: 'heartbeat_ack' }));
    assert.equal(harness.timeouts.has(probe[0]), false, 'an ack clears the deadline');
    await harness.dispatch(window, 'online');
    const second = [...harness.timeouts].find(([, timer]) => timer.ms === CLOUD_REALTIME_PROBE_ACK_MS)!;
    await act(async () => second[1].callback());
    assert.equal(socket.readyState, 3, 'a socket that does not answer is closed');
    assert.deepEqual(harness.reconnectDelays(), [500]);
  } finally {
    await harness.restore();
  }
});

test('a failed catch-up waits with the backoff and resumes from the same cursor', async (context) => {
  let catchUps = 0;
  const harness = await mountRealtime(context, async () => {
    catchUps += 1;
    if (catchUps <= 2) throw new CloudAuthError('network_error', 'Cloud request timed out.', 0);
  });
  try {
    await waitForReactCondition(() => harness.reconnectDelays().length === 1, 'the first failure schedules a retry');
    assert.deepEqual(harness.reconnectDelays(), [500]);
    assert.equal(FakeSocket.instances.length, 0, 'no socket opens before the catch-up succeeds');
    harness.advance(500);
    await harness.fireReconnect(500);
    await waitForReactCondition(() => harness.reconnectDelays().length === 1, 'the second failure schedules a retry');
    assert.deepEqual(harness.reconnectDelays(), [1_000]);
    harness.advance(1_000);
    await harness.fireReconnect(1_000);
    const socket = await harness.socket(1);
    await act(async () => socket.hello());
    assert.equal(socket.sent[0]?.cursor, 'saved-cursor-1');
    assert.equal(catchUps, 3);
    assert.equal(harness.warnings.length, 2);
  } finally {
    await harness.restore();
  }
});

test('a heartbeat never claims more than this socket delivered', async (context) => {
  const harness = await mountRealtime(context, async () => {});
  try {
    const socket = await harness.socket(1);
    await act(async () => socket.hello());
    // The local store ran ahead (to 7) through HTTP catch-up; this socket only sent 2.
    harness.setApplied(7);
    await act(async () => socket.frame({ type: 'event', stream_seq: 2 }));
    await waitForReactCondition(() => harness.cursorReads() === 2, 'the event catch-up reads the applied cursor');
    await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
    const heartbeat = [...harness.intervals.values()].find((timer) => timer.ms === 30_000);
    assert.ok(heartbeat);
    await act(async () => heartbeat.callback());
    assert.deepEqual(socket.sent.at(-1), { type: 'heartbeat', last_applied_seq: 2 });
  } finally {
    await harness.restore();
  }
});
