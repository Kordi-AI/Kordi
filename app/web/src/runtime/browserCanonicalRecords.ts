import type { CanonicalSessionMessage, CanonicalSessionState } from '@/kordi-app/types';
import { browserCanonicalMessageSummaries, browserCanonicalPage, compareCanonicalTimeline, type BrowserMessageSummaries } from './browserCanonicalProjection';
import type { BrowserChatSyncState } from './browserChatSync';

export const PROJECTION_STORE = 'projections';
export const MESSAGE_STORE = 'canonical-messages';

export type StoredCanonicalState = CanonicalSessionState & {
  storageRevision?: number;
  browserMessageSummaries?: BrowserMessageSummaries;
};

type StoredMessage = { scope: string; row: CanonicalSessionMessage };

export function canonicalMessageRange(scope: string, sessionId?: string) {
  const prefix = sessionId === undefined ? [scope] : [scope, sessionId];
  // IndexedDB sorts array keys after the string session ID and numeric sequence.
  return IDBKeyRange.bound(prefix, [...prefix, []], false, true);
}

function messageKey(scope: string, row: CanonicalSessionMessage) {
  return [scope, row.sessionId, row.sequenceNum];
}

export function upgradeCanonicalRecords(db: IDBDatabase, transaction: IDBTransaction, oldVersion: number) {
  const projections = oldVersion === 0 ? db.createObjectStore(PROJECTION_STORE) : transaction.objectStore(PROJECTION_STORE);
  const messages = db.createObjectStore(MESSAGE_STORE);
  messages.createIndex('message-id', ['scope', 'row.id'], { unique: true });
  messages.createIndex('timeline', ['scope', 'row.sessionId', 'row.createdAtMs', 'row.sequenceNum', 'row.id']);
  if (oldVersion === 0) return;
  const cursor = projections.openCursor();
  cursor.onsuccess = () => {
    const entry = cursor.result;
    if (!entry) return;
    const scope = entry.key;
    const record = entry.value as StoredCanonicalState;
    if (typeof scope === 'string' && !scope.startsWith('sync:') && Array.isArray(record.messages)) {
      for (const row of record.messages) messages.put({ scope, row }, messageKey(scope, row));
      entry.update({ ...record, browserMessageSummaries: browserCanonicalMessageSummaries(record.messages), messages: [] });
    }
    entry.continue();
  };
}

function writeMessages(
  store: IDBObjectStore,
  scope: string,
  before: ReadonlyMap<string, CanonicalSessionMessage>,
  record: StoredCanonicalState,
) {
  const changedSessions = new Set<string>();
  const remaining = new Map(before);
  for (const row of record.messages) {
    const previous = remaining.get(row.id);
    remaining.delete(row.id);
    if (previous === row) continue;
    if (previous && (previous.sessionId !== row.sessionId || previous.sequenceNum !== row.sequenceNum)) {
      store.delete(messageKey(scope, previous));
      changedSessions.add(previous.sessionId);
    }
    store.put({ scope, row }, messageKey(scope, row));
    changedSessions.add(row.sessionId);
  }
  for (const row of remaining.values()) {
    store.delete(messageKey(scope, row));
    changedSessions.add(row.sessionId);
  }
  if (!changedSessions.size) return record.browserMessageSummaries;
  const summaries = { ...record.browserMessageSummaries };
  for (const sessionId of changedSessions) delete summaries[sessionId];
  return { ...summaries, ...browserCanonicalMessageSummaries(record.messages.filter(row => changedSessions.has(row.sessionId))) };
}

export function readWriteCanonicalRecord<T>(
  db: IDBDatabase,
  scope: string,
  initial: () => StoredCanonicalState,
  update: (record: StoredCanonicalState, sync?: BrowserChatSyncState) => T,
  options: {
    readonly?: boolean;
    sessionId?: string;
    metadataOnly?: boolean;
    readSync?: boolean;
    shouldWrite?: () => boolean;
  } = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([PROJECTION_STORE, MESSAGE_STORE], options.readonly ? 'readonly' : 'readwrite');
    const projections = transaction.objectStore(PROJECTION_STORE);
    const messages = transaction.objectStore(MESSAGE_STORE);
    const metadata = projections.get(scope);
    const sync = options.readSync ? projections.get(`sync:${scope}`) : null;
    const records = options.metadataOnly ? null : messages.getAll(canonicalMessageRange(scope, options.sessionId));
    let result: T;
    let failure: unknown;
    const lastRequest = records ?? sync ?? metadata;
    lastRequest.onsuccess = () => {
      try {
        const record = (metadata.result as StoredCanonicalState | undefined) ?? initial();
        record.messages = ((records?.result ?? []) as StoredMessage[]).map(entry => entry.row);
        const before = options.readonly ? null : new Map(record.messages.map(row => [row.id, row]));
        result = update(record, sync?.result as BrowserChatSyncState | undefined);
        if (before && (options.shouldWrite?.() ?? true)) {
          const browserMessageSummaries = writeMessages(messages, scope, before, record);
          projections.put({ ...record, browserMessageSummaries, messages: [] }, scope);
        }
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure instanceof Error ? failure
      : new Error(transaction.error?.message ?? 'Chat storage was interrupted. Try again.'));
  });
}

export function readCanonicalMessagePage(
  db: IDBDatabase,
  scope: string,
  input: Parameters<typeof browserCanonicalPage>[1],
) {
  const { sessionId, timelineOrder, beforeSequenceNum, beforeTimeline } = input;
  const count = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
  return new Promise<ReturnType<typeof browserCanonicalPage>>((resolve, reject) => {
    const transaction = db.transaction(MESSAGE_STORE, 'readonly');
    const store = transaction.objectStore(MESSAGE_STORE);
    const source = timelineOrder ? store.index('timeline') : store;
    const prefix = [scope, sessionId];
    const range = timelineOrder && beforeTimeline
      ? IDBKeyRange.bound(prefix, [...prefix, beforeTimeline.createdAtMs, beforeTimeline.sequenceNum, beforeTimeline.id], false, true)
      : !timelineOrder && beforeSequenceNum != null
        ? IDBKeyRange.bound(prefix, [...prefix, beforeSequenceNum], false, true)
        : canonicalMessageRange(scope, sessionId);
    const cursor = source.openCursor(range, 'prev');
    const messages: CanonicalSessionMessage[] = [];
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      const { row } = entry.value as StoredMessage;
      if ((beforeSequenceNum == null || row.sequenceNum < beforeSequenceNum)
        && (!beforeTimeline || compareCanonicalTimeline(row, beforeTimeline) < 0)) {
        messages.push(row);
      }
      if (messages.length <= count) entry.continue();
    };
    transaction.onabort = () => reject(new Error(transaction.error?.message ?? 'Could not load chat history.'));
    transaction.oncomplete = () => resolve(browserCanonicalPage({ messages }, input));
  });
}
