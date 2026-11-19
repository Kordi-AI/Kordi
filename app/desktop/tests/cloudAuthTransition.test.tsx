import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { useCloudAuthTransition, waitForCloudAuthCover } from '../src/features/cloud/useCloudAuthTransition';

test('sign-out waits for the loading cover and shares one pending mutation', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const values = {
    window: dom.window, document: dom.window.document,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById('root')!);
  let transition!: ReturnType<typeof useCloudAuthTransition>;
  let signOuts = 0;
  const actions = {
    signOut: () => { signOuts++; return Promise.resolve(); },
  };
  function Probe() {
    transition = useCloudAuthTransition(actions);
    return createElement('div', null, transition.activity ?? 'idle');
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    assert.equal(document.getElementById('root')!.textContent, 'idle');

    let exit!: Promise<void>;
    await act(async () => {
      exit = transition.signOut();
      assert.equal(transition.signOut(), exit, 'duplicate clicks share one pending mutation');
    });
    assert.equal(document.getElementById('root')!.textContent, 'signing-out');
    assert.equal(signOuts, 0, 'the workspace must remain mounted until covered');
    await act(async () => exit);
    assert.equal(signOuts, 1);
    assert.equal(transition.activity, null);

    let cancelled!: Promise<void>;
    await act(async () => { cancelled = transition.signOut(); });
    await act(async () => root.unmount());
    await cancelled;
    assert.equal(signOuts, 1, 'unmounting during the cover must cancel the delayed mutation');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('a throttled or hidden WebKit window cannot indefinitely delay starting authentication', { timeout: 2000 }, async () => {
  const values = {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try {
    await waitForCloudAuthCover();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
