import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import {
  createCalendarShareClient,
  SHARE_AVAILABILITY_CAPTION,
  SHARE_AVAILABILITY_LABEL,
  SHARE_AVAILABILITY_SAVE_ERROR,
  type CalendarShareClient,
} from '../src/features/digest/calendarShareAvailability';
import { CalendarShareAvailabilityRow } from '../src/features/digest/CalendarShareAvailabilityRow';

async function withDom(run: () => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: 'http://127.0.0.1/' });
  const values = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try {
    await run();
  } finally {
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function fakeClient(initial: boolean | null, options: { fail?: boolean } = {}) {
  const writes: boolean[] = [];
  const client: CalendarShareClient = {
    async get() { return initial; },
    async set(enabled) {
      writes.push(enabled);
      if (options.fail) throw new Error('offline');
      return enabled;
    },
  };
  return { client, writes };
}

async function render(client: CalendarShareClient) {
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(createElement(CalendarShareAvailabilityRow, { client })));
  return root;
}

const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]');

test('the client reads and writes shareCalendarAvailability on /me', async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  let account: Record<string, unknown> = { accountId: 'acct_1', shareCalendarAvailability: true };
  let stores = true;
  const request = async <T,>(path: string, init: RequestInit) => {
    calls.push({ path, init });
    if (init.method === 'PATCH' && stores) account = { ...account, ...JSON.parse(String(init.body)) };
    return account as T;
  };
  const client = createCalendarShareClient({ request } as never, async () => ({ token: 'token' }));
  assert.equal(await client.get(), true);
  assert.equal(await client.set(false), false);
  assert.deepEqual(calls.map(({ path, init }) => [path, init.method]), [['/v1/cloud/auth/me', 'GET'], ['/v1/cloud/auth/me', 'PATCH']]);
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { shareCalendarAvailability: false });
  assert.equal((calls[1].init.headers as Record<string, string>).authorization, 'Bearer token');

  // Older servers neither report nor store the setting.
  account = { accountId: 'acct_1' };
  stores = false;
  assert.equal(await client.get(), null);
  await assert.rejects(client.set(true), new RegExp(SHARE_AVAILABILITY_SAVE_ERROR));
  const signedOut = createCalendarShareClient({ request } as never, async () => null);
  await assert.rejects(signedOut.get(), /Sign in/);
});

test('the row reads the setting and saves a change optimistically', async () => {
  await withDom(async () => {
    const { client, writes } = fakeClient(true);
    const root = await render(client);
    const text = document.body.textContent ?? '';
    assert.match(text, new RegExp(SHARE_AVAILABILITY_LABEL));
    assert.ok(text.includes(SHARE_AVAILABILITY_CAPTION));
    assert.equal(toggle()?.getAttribute('aria-checked'), 'true');
    assert.equal(toggle()?.getAttribute('aria-label'), SHARE_AVAILABILITY_LABEL);
    await act(async () => { toggle()!.click(); });
    assert.deepEqual(writes, [false]);
    assert.equal(toggle()?.getAttribute('aria-checked'), 'false');
    await act(async () => root.unmount());
  });
});

test('a failed save restores the previous value and says so', async () => {
  await withDom(async () => {
    const { client, writes } = fakeClient(true, { fail: true });
    const root = await render(client);
    await act(async () => { toggle()!.click(); });
    assert.deepEqual(writes, [false]);
    assert.equal(toggle()?.getAttribute('aria-checked'), 'true');
    assert.ok((document.body.textContent ?? '').includes(SHARE_AVAILABILITY_SAVE_ERROR));
    await act(async () => root.unmount());
  });
});

test('servers without the setting show no row', async () => {
  await withDom(async () => {
    const root = await render(fakeClient(null).client);
    assert.equal(toggle(), null);
    assert.equal(document.body.textContent, '');
    await act(async () => root.unmount());
  });
});
