import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchDesktopChatSessionActiveTurn } from '../src/lib/desktop';

async function withWindow<T>(value: unknown, run: () => Promise<T>) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value });
  try {
    return await run();
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('active turn lookup resolves to null without calling the native bridge outside the desktop shell', async () => {
  const calls: string[] = [];
  const browserWindow = { invoke: (command: string) => { calls.push(command); } };
  assert.equal(await withWindow(browserWindow, () => fetchDesktopChatSessionActiveTurn('any')), null);
  assert.equal(await fetchDesktopChatSessionActiveTurn('any'), null);
  assert.deepEqual(calls, []);
});

test('active turn lookup still calls the native bridge inside the desktop shell', async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const nativeWindow = { __TAURI_INTERNALS__: {
    invoke: async (command: string, args: unknown) => { calls.push({ command, args }); return null; },
  } };
  // The Tauri core module reads window.__TAURI_INTERNALS__ lazily at call time.
  const result = await withWindow(nativeWindow, () => fetchDesktopChatSessionActiveTurn('session-1'));
  assert.equal(result, null);
  assert.deepEqual(calls, [{ command: 'desktop_chat_session_active_turn', args: { sessionId: 'session-1' } }]);
});
