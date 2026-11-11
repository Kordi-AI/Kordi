import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { CloudAuthClient, type CloudAccount } from '../src/features/cloud/authClient';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { __resetCloudPresenceStoresForTests, useCloudPresence } from '../src/features/cloud/useCloudPresence';
import { waitForReactCondition } from './helpers/waitForReactCondition';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send() {}
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  open() { this.readyState = 1; this.onopen?.(); }
  presence(accountId: string, status: string) {
    this.onmessage?.({ data: JSON.stringify({
      subject: `kordi.events.presence.account.${accountId}`,
      payload: { account_id: accountId, status, occurred_at: '2026-11-10T08:00:00Z' },
    }) });
  }
}

test('the presence socket reconnects after a close and when the network returns', async (context) => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    WebSocket: globalThis.WebSocket,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, WebSocket: FakeSocket });
  FakeSocket.instances = [];
  __resetCloudPresenceStoresForTests();
  const now = 0;
  context.mock.method(Date, 'now', () => now);
  context.mock.method(Math, 'random', () => 0.5);
  let nextTimer = 0;
  const timeouts = new Map<number, { callback: () => void; ms: number }>();
  const intervals = new Map<number, { callback: () => void; ms: number }>();
  context.mock.method(window, 'setTimeout', (callback: () => void, ms: number) => { timeouts.set(++nextTimer, { callback, ms }); return nextTimer; });
  context.mock.method(window, 'clearTimeout', (id: number) => { timeouts.delete(id); });
  context.mock.method(window, 'setInterval', (callback: () => void, ms: number) => { intervals.set(++nextTimer, { callback, ms }); return nextTimer; });
  context.mock.method(window, 'clearInterval', (id: number) => { intervals.delete(id); });
  context.mock.method(CloudAuthClient.prototype, 'listContactPresence', async () => ({ accounts: [] }));
  const useToken = (token: string) => __setSessionBackendForTests({
    load: async () => ({ token, accountId: 'acct_owner', expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => {},
    clear: async () => {},
  });
  useToken('synthetic-token-1');
  const seen: string[] = [];
  function Harness() {
    const presence = useCloudPresence({ accountId: 'acct_owner', displayName: 'Owner' } as CloudAccount);
    const status = presence.snapshot.acct_peer?.status;
    if (status) seen.push(status);
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  let unmounted = false;
  try {
    await act(async () => root.render(createElement(Harness)));
    await waitForReactCondition(() => FakeSocket.instances.length === 1, 'the presence socket opens');
    const first = FakeSocket.instances[0];
    await act(async () => { first.open(); first.presence('acct_peer', 'online'); });
    assert.equal(seen.at(-1), 'online');

    // A connection reset: the socket comes back on its own after a jittered wait.
    await act(async () => first.close());
    const reconnect = [...timeouts].find(([, timer]) => timer.ms === 500);
    assert.ok(reconnect, 'a reconnect is scheduled with the shared backoff');
    useToken('synthetic-token-2');
    timeouts.delete(reconnect[0]);
    await act(async () => reconnect[1].callback());
    await waitForReactCondition(() => FakeSocket.instances.length === 2, 'the socket reconnects');
    const second = FakeSocket.instances[1];
    assert.match(second.url, /synthetic-token-2/, 'each attempt reads the current session');
    await act(async () => { second.open(); second.presence('acct_peer', 'offline'); });
    assert.equal(seen.at(-1), 'offline');

    // Offline, then the network returns: no waiting for the timer.
    await act(async () => second.close());
    assert.equal([...timeouts.values()].filter((timer) => timer.ms < 15_000).length, 1);
    await act(async () => { window.dispatchEvent(new dom.window.Event('online')); });
    await waitForReactCondition(() => FakeSocket.instances.length === 3, 'the socket reconnects when the network returns');
    assert.equal([...timeouts.values()].filter((timer) => timer.ms < 15_000).length, 0);
    await act(async () => { window.dispatchEvent(new dom.window.Event('online')); });
    assert.equal(FakeSocket.instances.length, 3, 'a socket being opened is not opened twice');

    await act(async () => root.unmount());
    unmounted = true;
    assert.equal(FakeSocket.instances[2].readyState, 3, 'the last listener closes the socket');
    assert.equal(timeouts.size, 0, 'and leaves no reconnect behind');
    assert.equal(intervals.size, 0);
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    __resetCloudPresenceStoresForTests();
    __setSessionBackendForTests(null);
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
