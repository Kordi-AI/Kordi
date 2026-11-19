// Erases what a deleted account left on this device. The Mac app marks the
// account's folder (APP_DATA_DIR/accounts/<hash>/) for removal at the next
// start, since the running app still uses it; the browser app removes the
// account's chat storage now. Both remove the account's local storage keys
// and its queued group sends.
import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import { invokeDesktop } from '@/lib/desktopInvoke';
import { CLOUD_GROUP_OUTBOX_DATABASE, CLOUD_GROUP_OUTBOX_STORE } from './cloudGroupOutbox';

/** Characters an account id is made of; anything else bounds an id inside a key. */
const ACCOUNT_ID_CHARACTER = /[A-Za-z0-9_-]/;
/** Fixed keys that hold who this device is to documents shared by link. */
const DOCUMENT_READER_KEYS = ['kordi.documentReaderKey.v1'];

/** Whether `key` names `accountId` as a whole id, not as part of a longer one. */
export function storageKeyNamesAccount(key: string, accountId: string): boolean {
  for (let index = key.indexOf(accountId); index >= 0; index = key.indexOf(accountId, index + 1)) {
    const before = key[index - 1];
    const after = key[index + accountId.length];
    const bounded = (character: string | undefined) => character === undefined || !ACCOUNT_ID_CHARACTER.test(character);
    if (bounded(before) && bounded(after)) return true;
  }
  return false;
}

/** Kordi's local storage keys that belong to `accountId`, plus the document reader keys. */
export function accountLocalStorageKeys(keys: Iterable<string>, accountId: string): string[] {
  const id = accountId.trim();
  if (!id.startsWith('acct_')) return [];
  return [...keys]
    .filter((key) => key.startsWith('kordi') && (storageKeyNamesAccount(key, id) || DOCUMENT_READER_KEYS.includes(key)))
    .sort();
}

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Removes the account's local storage keys; returns how many it removed. */
export function eraseAccountLocalStorage(accountId: string, storage: Storage | null = browserStorage()): number {
  if (!storage) return 0;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) keys.push(key);
    }
    const owned = accountLocalStorageKeys(keys, accountId);
    for (const key of owned) storage.removeItem(key);
    return owned.length;
  } catch {
    return 0;
  }
}

/** Deletes the account's queued group sends from the outbox database. */
export function eraseCloudGroupOutboxRecord(
  accountId: string,
  factory: IDBFactory | null = typeof indexedDB === 'undefined' ? null : indexedDB,
): Promise<void> {
  if (!factory) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const request = factory.open(CLOUD_GROUP_OUTBOX_DATABASE, 1);
    // The same schema the outbox creates, so opening first never breaks it.
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CLOUD_GROUP_OUTBOX_STORE)) {
        request.result.createObjectStore(CLOUD_GROUP_OUTBOX_STORE);
      }
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open the group outbox.'));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(CLOUD_GROUP_OUTBOX_STORE, 'readwrite');
      transaction.objectStore(CLOUD_GROUP_OUTBOX_STORE).delete(accountId.trim());
      const finish = (error?: unknown) => {
        database.close();
        if (error) reject(error instanceof Error ? error : new Error('Could not clear the group outbox.'));
        else resolve();
      };
      transaction.oncomplete = () => finish();
      transaction.onabort = () => finish(transaction.error ?? new Error('Could not clear the group outbox.'));
    };
  });
}

function isNativeShell(): boolean {
  return typeof window !== 'undefined'
    && typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
}

async function eraseBrowserAccountStorage(accountId: string): Promise<void> {
  const [{ clearBrowserCanonicalStorage }, { forgetBrowserAccount }] = await Promise.all([
    import('@web/runtime/browserCanonicalStorage'),
    import('@web/auth/browserSessionBackend'),
  ]);
  forgetBrowserAccount(accountId);
  await clearBrowserCanonicalStorage(accountId);
}

export type CloudAccountLocalDataEraser = {
  /** Mac app: marks the account folder for removal and stops its running agent turns. */
  markNativeStorage?: (accountId: string) => Promise<void>;
  /** Browser app: removes the account's chat storage. */
  eraseBrowserStorage?: (accountId: string) => Promise<void>;
  eraseOutbox: (accountId: string) => Promise<void>;
  storage: Storage | null;
};

function defaultEraser(): CloudAccountLocalDataEraser {
  return {
    markNativeStorage: isNativeShell()
      ? (accountId) => invokeDesktop<void>('cloud_account_storage_mark_for_removal', { accountId })
      : undefined,
    eraseBrowserStorage: import.meta.env?.VITE_KORDI_WEB_APP === '1' && isBrowserAppRuntime()
      ? eraseBrowserAccountStorage
      : undefined,
    eraseOutbox: (accountId) => eraseCloudGroupOutboxRecord(accountId),
    storage: browserStorage(),
  };
}

/**
 * Erases the deleted account's local data. Each part is best effort: a part
 * that fails never keeps the others from running or the session from ending.
 */
export async function eraseCloudAccountLocalData(
  accountId: string,
  eraser: CloudAccountLocalDataEraser = defaultEraser(),
): Promise<void> {
  const id = accountId.trim();
  if (!id) return;
  eraseAccountLocalStorage(id, eraser.storage);
  await Promise.allSettled([
    eraser.markNativeStorage?.(id),
    eraser.eraseBrowserStorage?.(id),
    eraser.eraseOutbox(id),
  ]);
}
