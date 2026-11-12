import { browserCanonicalScope } from '@web/runtime/browserCanonicalScope';
export { browserCanonicalScope } from '@web/runtime/browserCanonicalScope';
import type { CanonicalSessionState } from '@/kordi-app/types';
import { browserCanonicalCatalog, browserCanonicalCloudMessageId, browserCanonicalPage, emptyBrowserCanonicalState } from '@web/runtime/browserCanonicalProjection';
import { applyBrowserCanonicalCommand } from '@web/runtime/browserCanonicalCommands';
import { browserCanonicalCommandChanged } from '@web/runtime/browserCanonicalChanges';

const DATABASE_NAME = 'kordi-browser-canonical-v1';
import {
  canonicalMessageRange, MESSAGE_STORE, PROJECTION_STORE, readCanonicalMessagePage, readWriteCanonicalRecord,
  type StoredCanonicalState, upgradeCanonicalRecords,
} from './browserCanonicalRecords';
export const BROWSER_CANONICAL_CHANGED_EVENT = 'kordi-browser-canonical-changed';
let database: Promise<IDBDatabase> | null = null;
const activeScopes = new Set<string>();
let storageGeneration = 0;


const canonicalWrites = new Map<string, Promise<unknown>>();

function queueCanonicalWrite<T>(scope: string, write: () => Promise<T>) {
  const previous = canonicalWrites.get(scope);
  const next = (previous ?? Promise.resolve()).catch(() => undefined).then(write);
  canonicalWrites.set(scope, next);
  const release = () => { if (canonicalWrites.get(scope) === next) canonicalWrites.delete(scope); };
  void next.then(release, release);
  return next;
}

function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Browser storage is unavailable. Allow site storage and reload Kordi.'));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, 2);
    request.onupgradeneeded = event => upgradeCanonicalRecords(request.result, request.transaction!, event.oldVersion);
    request.onerror = () => reject(request.error ?? new Error('Could not open browser chat storage.'));
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = null; };
      resolve(request.result);
    };
  }).catch(error => { database = null; throw error; });
  return database;
}

export async function updateBrowserStoredRecord<T, R>(key: string, initial: () => T,
  update: (record: T) => R, readonly = false, shouldWrite: () => boolean = () => true): Promise<R> {
  const generation = storageGeneration;
  activeScopes.add(key);
  const db = await openDatabase();
  if (generation !== storageGeneration) throw new Error('The signed-in account changed.');
  return new Promise<R>((resolve, reject) => {
    const transaction = db.transaction(PROJECTION_STORE, readonly ? 'readonly' : 'readwrite');
    const store = transaction.objectStore(PROJECTION_STORE);
    const request = store.get(key);
    let result: R;
    let failure: unknown;
    request.onsuccess = () => {
      try {
        const record = (request.result as T | undefined) ?? initial();
        result = update(record);
        if (!readonly && shouldWrite()) store.put(record, key);
      } catch (error) { failure = error; transaction.abort(); }
    };
    transaction.onabort = () => reject(failure instanceof Error ? failure
      : new Error(transaction.error?.message ?? 'Chat storage was interrupted. Try again.'));
    transaction.onerror = () => reject(new Error(transaction.error?.message ?? 'Could not save browser chat data.'));
    transaction.oncomplete = () => resolve(result);
  });
}

/** A read/write IndexedDB transaction serializes concurrent tabs and prevents lost updates. */
export async function runBrowserCanonicalCommand(accountId: string, organizationId: string | undefined,
  command: string, args: Record<string, unknown> = {}) {
  const scope = browserCanonicalScope(accountId, organizationId);
  if (args.expectedBrowserScope !== undefined && args.expectedBrowserScope !== scope) {
    throw new Error('The organization changed while replaying this conversation.');
  }
  const readonly = ['desktop_canonical_session_state', 'desktop_canonical_session_catalog',
    'desktop_canonical_session_messages', 'desktop_canonical_existing_message_sources'].includes(command);
  let changed = false;
  const generation = storageGeneration;
  activeScopes.add(scope);
  const db = await openDatabase();
  if (generation !== storageGeneration) throw new Error('The signed-in account changed.');
  if (command === 'desktop_canonical_session_messages') {
    return readCanonicalMessagePage(db, scope, args as Parameters<typeof browserCanonicalPage>[1]);
  }
  const apply = () => readWriteCanonicalRecord(db, scope, () => emptyBrowserCanonicalState(accountId), record => {
    if (generation !== storageGeneration) throw new Error('The signed-in account changed.');
    if (command === 'desktop_canonical_session_catalog') return browserCanonicalCatalog(record, record.browserMessageSummaries);
    const applied = browserCanonicalCommandChanged(record, command, () => applyBrowserCanonicalCommand(record, command, args));
    changed = applied.changed;
    if (!readonly && changed) record.storageRevision = (record.storageRevision ?? 0) + 1;
    return applied.result;
  }, {
    readonly, shouldWrite: () => changed,
    metadataOnly: command === 'desktop_canonical_session_catalog'
      || command === 'desktop_canonical_upsert_identity_fast'
      || command === 'desktop_canonical_adopt_cloud_profile_identity'
      || command === 'desktop_canonical_open_or_create_session_fast',
  });
  const result = await (readonly ? apply() : queueCanonicalWrite(scope, apply));
  // A replay that changed nothing must not refresh the store: the refresh
  // re-runs replay, which would otherwise write and refresh again forever.
  if (!readonly && changed && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(BROWSER_CANONICAL_CHANGED_EVENT));
  return result;
}

/** Stage a history page outside IndexedDB, then commit it against the revision
 * it read. Concurrent tabs and live updates keep their normal transaction order. */
export async function runBrowserCanonicalReplay<T>(
  accountId: string,
  organizationId: string | undefined,
  sessionId: string,
  isCurrent: () => boolean,
  replay: (state: CanonicalSessionState, apply: (command: string, args: Record<string, unknown>) => unknown) => Promise<T>,
): Promise<T | undefined> {
  const scope = browserCanonicalScope(accountId, organizationId);
  const initial = (): StoredCanonicalState => emptyBrowserCanonicalState(accountId);
  const generation = storageGeneration;
  activeScopes.add(scope);
  const db = await openDatabase();
  if (generation !== storageGeneration) return undefined;
  return queueCanonicalWrite(scope, async () => {
    for (let attempt = 0; attempt < 3 && generation === storageGeneration && isCurrent(); attempt += 1) {
      const state = await readWriteCanonicalRecord(db, scope, initial, record => record, { readonly: true, sessionId });
      const revision = state.storageRevision ?? 0;
      const original = new Map(state.messages.map(row => [row.id, row]));
      let changed = false;
      const result = await replay(state, (command, args) => {
        const applied = browserCanonicalCommandChanged(state, command, () => applyBrowserCanonicalCommand(state, command, args));
        changed ||= applied.changed;
        return applied.result;
      });
      if (generation !== storageGeneration || !isCurrent()) return undefined;
      if (!changed) return result;
      let committed = false;
      await readWriteCanonicalRecord(db, scope, initial, record => {
        if (generation !== storageGeneration || !isCurrent() || (record.storageRevision ?? 0) !== revision) return;
        const current = new Map(record.messages.map(row => [row.id, row]));
        const messages = state.messages.map(row => original.get(row.id) === row ? current.get(row.id) ?? row : row);
        Object.assign(record, state, { messages, storageRevision: revision + 1 });
        committed = true;
      }, { sessionId, shouldWrite: () => committed });
      if (committed) {
        window.dispatchEvent(new CustomEvent(BROWSER_CANONICAL_CHANGED_EVENT));
        return result;
      }
    }
    if (isCurrent()) throw new Error('Chat history changed while loading. Try again.');
    return undefined;
  });
}

export async function clearBrowserCanonicalStorage(accountId?: string) {
  storageGeneration += 1;
  const scopes = [...activeScopes];
  activeScopes.clear();
  if (!scopes.length && !accountId) return;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([PROJECTION_STORE, MESSAGE_STORE], 'readwrite');
    const store = transaction.objectStore(PROJECTION_STORE);
    const messages = transaction.objectStore(MESSAGE_STORE);
    const removeScope = (scope: string) => {
      store.delete(scope);
      if (!scope.startsWith('sync:')) messages.delete(canonicalMessageRange(scope));
    };
    if (accountId) {
      const cursor = store.openKeyCursor();
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        const key = cursor.result.key;
        if (typeof key === 'string') {
          try {
            const parsed = JSON.parse(key.startsWith('sync:') ? key.slice(5) : key) as unknown;
            if (Array.isArray(parsed) && parsed[0] === accountId) removeScope(key);
          } catch { /* Other versions of the cache own their own records. */ }
        }
        cursor.result.continue();
      };
    } else for (const scope of scopes) removeScope(scope);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error(transaction.error?.message ?? 'Could not clear browser chat data.'));
  });
}

/** Compare both durable projections inside one transaction, so concurrent sync
 * cannot make newly arrived server messages appear missing. */
export async function pruneBrowserCanonicalCloudMessages(accountId: string, organizationId?: string): Promise<string[]> {
  const scope = browserCanonicalScope(accountId, organizationId);
  const generation = storageGeneration;
  const db = await openDatabase();
  if (generation !== storageGeneration) throw new Error('The signed-in account changed.');
  const removed: string[] = [];
  await queueCanonicalWrite(scope, () => readWriteCanonicalRecord(db, scope, () => emptyBrowserCanonicalState(accountId), (canonical, sync) => {
    if (!sync || generation !== storageGeneration) return;
    const live = new Set(sync.messages.map(row => row.id));
    const deleted = new Set(sync.deletedMessageIds);
    const groupSessions = new Set(sync.conversations.filter(row => row.kind === 'group')
      .map(row => row.legacy_session_id ?? row.id));
    canonical.messages = canonical.messages.filter(row => {
      const cloudId = browserCanonicalCloudMessageId(row);
      if (!cloudId || live.has(cloudId)) return true;
      if (row.sessionId.startsWith('session:group:') && !deleted.has(cloudId)
        && (!sync.pinCacheReady || groupSessions.has(row.sessionId))) return true;
      removed.push(row.id);
      return false;
    });
    if (removed.length) canonical.storageRevision = (canonical.storageRevision ?? 0) + 1;
  }, { readSync: true, shouldWrite: () => removed.length > 0 }));
  return removed;
}
