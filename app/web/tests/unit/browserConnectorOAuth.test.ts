import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';

import {
  CONNECTOR_OAUTH_CHANNEL,
  connectorCallbackAck,
  connectorCallbackMessage,
  connectorCallbackUrl,
  createBrowserConnectorOAuthHandoff,
  createConnectorFlowId,
  isConnectorCallbackLocation,
  isConnectorFlowId,
  readConnectorCallbackAck,
  readConnectorCallbackMessage,
  type ConnectorChannel,
  type ConnectorPopup,
} from '@web/runtime/browserConnectorOAuth';
import {
  createConnectorCallbackRenderer,
  runConnectorCallbackPage,
  type ConnectorCallbackView,
} from '@web/runtime/browserConnectorCallbackPage';

const ORIGIN = 'https://app.kordi.test';
const FLOW = 'synthetic_flow_id_0123456789';
const OTHER_FLOW = 'synthetic_other_flow_987654';
const RESULT = '#kordi_connector=eyJjb21wbGV0aW9uQ29kZSI6InN5bnRoZXRpYyJ9';
const ERROR = '#kordi_connector_error=Access%20was%20not%20granted.&kordi_connector_error_code=provider_denied';

/** Same-origin BroadcastChannel stand-in: delivers to the other open channels of the same name. */
class FakeChannelHub {
  readonly channels = new Set<FakeChannel>();
  opened = 0;

  open(name: string): FakeChannel {
    const channel = new FakeChannel(this, name);
    this.channels.add(channel);
    this.opened += 1;
    return channel;
  }
}

class FakeChannel implements ConnectorChannel {
  readonly listeners = new Set<(event: MessageEvent) => void>();
  readonly posted: unknown[] = [];
  closed = false;

  constructor(private readonly hub: FakeChannelHub, readonly name: string) {}

  postMessage(message: unknown) {
    if (this.closed) throw new Error('The channel is closed.');
    this.posted.push(message);
    const data = structuredClone(message);
    for (const other of this.hub.channels) {
      if (other !== this && other.name === this.name) queueMicrotask(() => other.dispatch(data));
    }
  }

  dispatch(data: unknown) {
    if (this.closed) return;
    for (const listener of [...this.listeners]) listener({ data } as MessageEvent);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void) { this.listeners.add(listener); }
  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void) { this.listeners.delete(listener); }

  close() {
    this.closed = true;
    this.hub.channels.delete(this);
  }
}

class FakePopup implements ConnectorPopup {
  opener: unknown = { parent: true };
  closed = false;
  readonly navigations: string[] = [];
  readonly location = { replace: (url: string) => { this.navigations.push(url); } };
  close() { this.closed = true; }
}

function handoffFixture(options: { blocked?: number; channels?: boolean } = {}) {
  const hub = new FakeChannelHub();
  const opened: { url: string; popup: FakePopup | null }[] = [];
  let blocked = options.blocked ?? 0;
  const handoff = createBrowserConnectorOAuthHandoff({
    origin: () => ORIGIN,
    basePath: '/app/',
    openWindow: (url) => {
      const popup = blocked > 0 ? null : new FakePopup();
      if (blocked > 0) blocked -= 1;
      opened.push({ url, popup });
      return popup;
    },
    openChannel: (name) => (options.channels === false ? null : hub.open(name)),
    createFlowId: () => FLOW,
  });
  return { hub, opened, handoff };
}

/** A tab on the same origin as the callback page, posting on the shared channel. */
function otherTab(hub: FakeChannelHub) {
  return hub.open(CONNECTOR_OAUTH_CHANNEL);
}

const flush = () => new Promise<void>((resolve) => { setImmediate(resolve); });

test('a flow id is URL-safe, random, and at least 128 bits', () => {
  const ids = new Set(Array.from({ length: 50 }, () => createConnectorFlowId()));
  assert.equal(ids.size, 50);
  for (const id of ids) {
    assert.match(id, /^[A-Za-z0-9_-]{22}$/);
    assert.ok(isConnectorFlowId(id));
  }
  assert.equal(createConnectorFlowId({ getRandomValues: <T extends ArrayBufferView | null>(array: T) => {
    new Uint8Array((array as unknown as Uint8Array).buffer).fill(0xff);
    return array;
  } }), '_'.repeat(21) + 'w');
  for (const value of ['', 'short', 'has space in it 0123456789', 'a/b'.repeat(10), null, 42]) {
    assert.equal(isConnectorFlowId(value), false, String(value));
  }
});

test('the callback page is the application entry with the flow id in the query', () => {
  assert.equal(connectorCallbackUrl(ORIGIN, '/app/', FLOW), `${ORIGIN}/app/?connectorFlow=${FLOW}`);
  assert.equal(connectorCallbackUrl(ORIGIN, '/app', FLOW), `${ORIGIN}/app/?connectorFlow=${FLOW}`);
  assert.equal(connectorCallbackUrl('http://127.0.0.1:62483', '/app/', FLOW), `http://127.0.0.1:62483/app/?connectorFlow=${FLOW}`);
  assert.ok(isConnectorCallbackLocation({ pathname: '/app/', search: `?connectorFlow=${FLOW}` }, '/app/'));
  assert.ok(isConnectorCallbackLocation({ pathname: '/app', search: `?connectorFlow=${FLOW}` }, '/app/'));
  assert.ok(!isConnectorCallbackLocation({ pathname: '/app/', search: '' }, '/app/'));
  assert.ok(!isConnectorCallbackLocation({ pathname: '/app/', search: '?welcome=1' }, '/app/'));
  assert.ok(!isConnectorCallbackLocation({ pathname: '/app/chats', search: `?connectorFlow=${FLOW}` }, '/app/'));
});

test('messages are read only in their exact shape', () => {
  assert.deepEqual(readConnectorCallbackMessage(connectorCallbackMessage(FLOW, RESULT)), connectorCallbackMessage(FLOW, RESULT));
  assert.deepEqual(readConnectorCallbackAck(connectorCallbackAck(FLOW)), connectorCallbackAck(FLOW));
  for (const value of [
    null, 'text', { flow: FLOW, fragment: RESULT }, connectorCallbackAck(FLOW),
    connectorCallbackMessage('bad flow', RESULT), connectorCallbackMessage(FLOW, 'no-hash'),
    connectorCallbackMessage(FLOW, '#'), connectorCallbackMessage(FLOW, `#${'x'.repeat(9_000)}`),
    { ...connectorCallbackMessage(FLOW, RESULT), fragment: 7 },
  ]) {
    assert.equal(readConnectorCallbackMessage(value), null, JSON.stringify(value)?.slice(0, 80));
  }
  assert.equal(readConnectorCallbackAck(connectorCallbackMessage(FLOW, RESULT)), null);
  assert.equal(readConnectorCallbackAck({ type: 'kordi-connector-callback-ack', flow: 'x' }), null);
});

test('prepare opens a blank detached window before anything is awaited, and open navigates it', async () => {
  const { opened, handoff } = handoffFixture();
  const pending = handoff.prepare();
  assert.equal(opened.length, 1, 'the window opens synchronously inside prepare');
  assert.equal(opened[0].url, '');
  assert.equal(opened[0].popup?.opener, null);
  const callback = await pending;
  assert.ok(callback);
  assert.equal(callback.redirectUrl, `${ORIGIN}/app/?connectorFlow=${FLOW}`);
  assert.equal(await handoff.open('https://provider.example.test/consent'), true);
  assert.equal(opened.length, 1, 'no second window');
  assert.deepEqual(opened[0].popup?.navigations, ['https://provider.example.test/consent']);
  await callback.cancel();
});

test('open falls back to a new window and reports a blocked pop-up', async () => {
  const fallback = handoffFixture({ blocked: 1 });
  const callback = await fallback.handoff.prepare();
  assert.ok(callback, 'a blocked blank window does not fail prepare');
  assert.equal(await fallback.handoff.open('https://provider.example.test/consent'), true);
  assert.equal(fallback.opened[1].url, 'https://provider.example.test/consent');
  assert.equal(fallback.opened[1].popup?.opener, null);
  await callback.cancel();
  assert.equal(fallback.opened[1].popup?.closed, true, 'canceling closes the unfinished provider window');

  const blocked = handoffFixture({ blocked: 2 });
  const blockedCallback = await blocked.handoff.prepare();
  assert.equal(await blocked.handoff.open('https://provider.example.test/consent'), false);
  await blockedCallback?.cancel();

  const closedByUser = handoffFixture();
  const closedCallback = await closedByUser.handoff.prepare();
  closedByUser.opened[0].popup!.closed = true;
  assert.equal(await closedByUser.handoff.open('https://provider.example.test/consent'), true);
  assert.equal(closedByUser.opened.length, 2);
  await closedCallback?.cancel();
});

test('without BroadcastChannel the handoff steps aside and opens no window early', async () => {
  const { opened, handoff } = handoffFixture({ channels: false });
  assert.equal(await handoff.prepare(), null);
  assert.equal(opened.length, 0);
});

test('wait resolves only for its own flow, acknowledges it, and cleans up', async () => {
  const { hub, opened, handoff } = handoffFixture();
  const callback = await handoff.prepare();
  assert.ok(callback);
  await handoff.open('https://provider.example.test/consent');
  const starter = [...hub.channels][0];
  const tab = otherTab(hub);
  const acks: unknown[] = [];
  tab.addEventListener('message', (event) => { acks.push(event.data); });

  let resolved: string | null = null;
  const waiting = callback.wait(60_000).then((fragment) => { resolved = fragment; return fragment; });
  tab.postMessage(connectorCallbackMessage(OTHER_FLOW, RESULT));
  tab.postMessage({ flow: FLOW, fragment: RESULT });
  tab.postMessage(connectorCallbackMessage(FLOW, 'not a fragment'));
  tab.postMessage('noise');
  await flush();
  assert.equal(resolved, null);
  assert.deepEqual(acks, []);

  tab.postMessage(connectorCallbackMessage(FLOW, RESULT));
  assert.equal(await waiting, RESULT);
  await flush();
  assert.deepEqual(acks, [connectorCallbackAck(FLOW)]);
  assert.equal(starter.closed, true);
  assert.equal(starter.listeners.size, 0);
  await callback.cancel();
  assert.equal(opened[0].popup?.closed, false, 'a window that reached the callback page closes itself');
  tab.close();
});

test('a callback that arrives before wait is kept for it', async () => {
  const { hub, handoff } = handoffFixture();
  const callback = await handoff.prepare();
  assert.ok(callback);
  const tab = otherTab(hub);
  tab.postMessage(connectorCallbackMessage(FLOW, ERROR));
  await flush();
  assert.equal(await callback.wait(60_000), ERROR);
  assert.equal(hub.channels.has(tab), true);
  assert.equal(hub.channels.size, 1, 'the starting tab closed its channel');
  tab.close();
});

test('wait times out with a timed out message and cleans up', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { hub, opened, handoff } = handoffFixture();
  const callback = await handoff.prepare();
  assert.ok(callback);
  await handoff.open('https://provider.example.test/consent');
  const starter = [...hub.channels][0];
  const waiting = callback.wait(1_000);
  t.mock.timers.tick(1_000);
  await assert.rejects(waiting, /timed out/i);
  assert.equal(starter.closed, true);
  assert.equal(starter.listeners.size, 0);
  await callback.cancel();
  assert.equal(opened[0].popup?.closed, true);
});

test('cancel stops a pending wait, closes the channel, and closes the unused window', async () => {
  const { hub, opened, handoff } = handoffFixture();
  const callback = await handoff.prepare();
  assert.ok(callback);
  const waiting = callback.wait(60_000);
  await callback.cancel();
  await assert.rejects(waiting, /canceled/);
  assert.equal(hub.channels.size, 0);
  assert.equal(opened[0].popup?.closed, true);
  await assert.rejects(callback.wait(60_000), /canceled/);
});

function callbackPage(t: TestContext, hash: string, search = `?connectorFlow=${FLOW}`) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const hub = new FakeChannelHub();
  const views: ConnectorCallbackView[] = [];
  const replaced: string[] = [];
  let closed = 0;
  const location = { pathname: '/app/', search, hash };
  const stop = runConnectorCallbackPage({
    location,
    history: { state: { kept: true }, replaceState: (_state: unknown, _unused: string, url?: string | URL | null) => {
      replaced.push(String(url));
      location.hash = '';
    } },
    openChannel: (name) => hub.open(name),
    render: (view) => { views.push(view); },
    closeWindow: () => { closed += 1; },
    repostIntervalMs: 500,
    repostLimitMs: 2_000,
  });
  return { hub, views, replaced, stop, closed: () => closed, location };
}

test('the callback page strips the fragment, re-posts until acknowledged, then closes', async (t: TestContext) => {
  const fetches: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((...args: unknown[]) => {
    fetches.push(args);
    return Promise.reject(new Error('no network'));
  }) as unknown as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const fixture = callbackPage(t, RESULT);
  const { hub, views, replaced, location } = fixture;
  assert.deepEqual(replaced, [`/app/?connectorFlow=${FLOW}`]);
  assert.equal(location.hash, '');
  assert.deepEqual(views, ['waiting']);
  const page = [...hub.channels][0];
  const starter = otherTab(hub);
  const received: unknown[] = [];
  starter.addEventListener('message', (event) => { received.push(event.data); });
  assert.deepEqual(page.posted, [connectorCallbackMessage(FLOW, RESULT)]);
  t.mock.timers.tick(500);
  t.mock.timers.tick(500);
  assert.equal(page.posted.length, 3);
  await flush();
  assert.equal(received.length, 2);

  starter.postMessage(connectorCallbackAck(OTHER_FLOW));
  await flush();
  assert.equal(page.closed, false);
  starter.postMessage(connectorCallbackAck(FLOW));
  await flush();
  assert.equal(page.closed, true);
  assert.equal(page.listeners.size, 0);
  assert.deepEqual(views, ['waiting', 'connected']);
  assert.equal(fixture.closed(), 1);
  t.mock.timers.tick(5_000);
  assert.equal(page.posted.length, 3, 'no posts after the acknowledgement');
  assert.deepEqual(fetches, [], 'the page never finishes the grant itself');
  starter.close();
});

test('an error result is relayed and the page tells the user to try again in Kordi', async (t: TestContext) => {
  const { hub, views, closed } = callbackPage(t, ERROR);
  const page = [...hub.channels][0];
  assert.deepEqual(page.posted, [connectorCallbackMessage(FLOW, ERROR)]);
  assert.deepEqual(views, ['not_connected']);
  const starter = otherTab(hub);
  starter.postMessage(connectorCallbackAck(FLOW));
  await flush();
  assert.equal(page.closed, true);
  assert.deepEqual(views, ['not_connected']);
  assert.equal(closed(), 0);
  starter.close();
});

test('the callback page gives up after its limit when nothing answers', (t: TestContext) => {
  const { hub, views } = callbackPage(t, RESULT);
  const page = [...hub.channels][0];
  t.mock.timers.tick(10_000);
  assert.equal(page.posted.length, 4);
  assert.equal(page.closed, true);
  assert.deepEqual(views, ['waiting', 'return']);
});

test('a callback without a flow or a result relays nothing', (t: TestContext) => {
  const missingFlow = callbackPage(t, RESULT, '?connectorFlow=bad');
  assert.deepEqual(missingFlow.replaced, ['/app/?connectorFlow=bad']);
  assert.equal(missingFlow.hub.opened, 0);
  assert.deepEqual(missingFlow.views, ['return']);
  t.mock.timers.reset();

  const missingFragment = callbackPage(t, '');
  assert.deepEqual(missingFragment.replaced, []);
  assert.equal(missingFragment.hub.opened, 0);
  assert.deepEqual(missingFragment.views, ['return']);
  t.mock.timers.reset();

  const unrelatedFragment = callbackPage(t, '#section');
  assert.equal(unrelatedFragment.hub.opened, 0);
  assert.deepEqual(unrelatedFragment.views, ['return']);
});

test('the handoff and the callback page finish a flow together', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { hub, handoff } = handoffFixture();
  const callback = await handoff.prepare();
  assert.ok(callback);
  await handoff.open('https://provider.example.test/consent');
  const waiting = callback.wait(60_000);
  const views: ConnectorCallbackView[] = [];
  let closed = 0;
  runConnectorCallbackPage({
    location: { pathname: '/app/', search: new URL(callback.redirectUrl).search, hash: RESULT },
    history: { state: null, replaceState: () => undefined },
    openChannel: (name) => hub.open(name),
    render: (view) => { views.push(view); },
    closeWindow: () => { closed += 1; },
  });
  assert.equal(await waiting, RESULT);
  await flush();
  assert.deepEqual(views, ['waiting', 'connected']);
  assert.equal(closed, 1);
  assert.equal(hub.channels.size, 0);
  await callback.cancel();
});

test('the callback page renders plain themed text without the application', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const root = dom.window.document.getElementById('root')!;
  const render = createConnectorCallbackRenderer(dom.window.document, root);
  render('waiting');
  assert.equal(root.querySelector('[role="status"]')?.textContent, 'ConnectingFinishing in Kordi…');
  render('connected');
  assert.equal(root.querySelector('h1')?.textContent, 'Connected');
  assert.equal(root.querySelector('p')?.textContent, 'You can close this tab.');
  assert.match(root.querySelector('main')?.className ?? '', /\bkordi-app theme-(?:light|dark)\b/);
  assert.match(dom.window.document.body.className, /\btheme-(?:light|dark)\b/);
});
