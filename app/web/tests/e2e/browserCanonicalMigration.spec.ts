import { expect, test } from '@playwright/test';
import { account, installApiFixture } from './apiFixture';

test('the browser upgrades a populated chat cache and preserves its messages', async ({ page, baseURL }) => {
  await installApiFixture(page, baseURL!, true);
  await page.route('**/fixture-canonical-seed', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Synthetic cache fixture</title>',
  }));
  await page.goto('/fixture-canonical-seed');
  const scope = JSON.stringify([account.accountId, 'browser-test-org']);
  const sessionId = 'session:self-agent:cache-fixture';
  const messageCount = 4000;
  await page.evaluate(async ({ scope, account, sessionId, messageCount }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('kordi-browser-canonical-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('projections');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('projections', 'readwrite');
        const store = transaction.objectStore('projections');
        const humanIdentityId = `human:${account.accountId}`;
        const now = Date.UTC(2026, 9, 20);
        store.put({
          storagePath: '',
          profile: { id: `web:${account.accountId}`, humanIdentityId, storageRoot: '', createdAtMs: now, updatedAtMs: now },
          identities: [{ id: humanIdentityId, kind: 'human', source: 'cloud', humanId: account.accountId,
            displayName: account.displayName, createdAtMs: now, updatedAtMs: now }],
          sessions: [{ id: sessionId, kind: 'self-agent', status: 'active', title: 'Archived fixture',
            createdAtMs: now, updatedAtMs: now, createdByIdentityId: humanIdentityId }],
          participants: [{ sessionId, identityId: humanIdentityId, role: 'self', state: 'active', addedAtMs: now }],
          delegatedExchanges: [], presence: [], contextSnapshots: [],
          messages: Array.from({ length: messageCount }, (_, index) => ({
            id: `fixture-cache-${index + 1}`, sessionId, senderIdentityId: humanIdentityId,
            senderRole: 'user', messageKind: 'text', status: 'sent', sequenceNum: index + 1,
            contentText: `Cached fixture ${index + 1}.`, createdAtMs: now + index, updatedAtMs: now + index,
          })),
        }, scope);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
  }, { scope, account, sessionId, messageCount });
  await page.goto(`/app/chats/${encodeURIComponent(sessionId)}`);
  await expect(page.getByRole('region', { name: 'Conversation messages' })
    .getByText(`Cached fixture ${messageCount}.`, { exact: true })).toBeVisible();
  const migrated = await page.evaluate(async ({ scope, sessionId, messageCount }) => {
    return new Promise<{ rows: number; embedded: number; last: string }>((resolve, reject) => {
      const request = indexedDB.open('kordi-browser-canonical-v1', 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(['projections', 'canonical-messages']);
        const metadata = transaction.objectStore('projections').get(scope);
        const messages = transaction.objectStore('canonical-messages');
        const rows = messages.count(IDBKeyRange.bound([scope, sessionId, 1], [scope, sessionId, messageCount]));
        const last = messages.get([scope, sessionId, messageCount]);
        transaction.oncomplete = () => {
          db.close();
          resolve({ rows: rows.result, embedded: metadata.result.messages.length, last: last.result.row.id });
        };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
  }, { scope, sessionId, messageCount });
  expect(migrated).toEqual({ rows: messageCount, embedded: 0, last: `fixture-cache-${messageCount}` });
});
