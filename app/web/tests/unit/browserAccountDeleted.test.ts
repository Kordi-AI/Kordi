import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onAccountDeleted, type AccountDeletedReport } from '@/features/cloud/accountDeletedSignal';
import {
  BROWSER_LAST_ACCOUNT_KEY,
  BrowserSessionBackend,
  forgetBrowserAccount,
} from '@web/auth/browserSessionBackend';

const origin = 'https://web.example.test';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

async function withBrowserWindow<T>(run: (storage: Storage) => Promise<T>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storage = memoryStorage();
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { localStorage: storage } });
  try {
    return await run(storage);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

function backendAnswering(status: number, body: unknown) {
  return new BrowserSessionBackend(async () => Response.json(body, { status }), origin);
}

test('a restored session remembers its public account id', async () => {
  await withBrowserWindow(async (storage) => {
    const session = await backendAnswering(200, { account: { accountId: 'acct_browser' }, session: { expiresAt: '2099-01-01T00:00:00Z' } }).load();
    assert.equal(session?.accountId, 'acct_browser');
    assert.equal(storage.getItem(BROWSER_LAST_ACCOUNT_KEY), 'acct_browser');
    forgetBrowserAccount('acct_other');
    assert.equal(storage.getItem(BROWSER_LAST_ACCOUNT_KEY), 'acct_browser');
    forgetBrowserAccount('acct_browser');
    assert.equal(storage.getItem(BROWSER_LAST_ACCOUNT_KEY), null);
  });
});

test('a deleted account\'s cookie erases that account before the page signs out', async () => {
  const reports: AccountDeletedReport[] = [];
  let finished = false;
  const stop = onAccountDeleted(async (report) => {
    await new Promise(resolve => setTimeout(resolve, 5));
    reports.push(report);
    finished = true;
  });
  try {
    await withBrowserWindow(async (storage) => {
      storage.setItem(BROWSER_LAST_ACCOUNT_KEY, 'acct_browser');
      const session = await backendAnswering(401, { errorCode: 'account_deleted', message: 'This account was deleted.' }).load();
      assert.equal(session, null);
      // The erase finished before load answered, so the redirect cannot cut it short.
      assert.equal(finished, true);
      assert.deepEqual(reports, [{ accountId: 'acct_browser' }]);

      reports.length = 0;
      assert.equal(await backendAnswering(401, { errorCode: 'login_required', message: 'Sign in.' }).load(), null);
      assert.deepEqual(reports, []);
    });
  } finally {
    stop();
  }
});
