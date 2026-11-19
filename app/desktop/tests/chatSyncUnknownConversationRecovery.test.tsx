import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useCloudMessageSync, type CloudMessageSyncController, type CloudMessageSyncStores } from '../src/features/cloud/useCloudMessageSync';
import { CloudSyncCoordinator } from '../src/features/cloud/cloudSyncCoordinator';
import { cloudUnreadReadinessContextKey, type CloudUnreadReadinessSnapshot } from '../src/features/cloud/cloudMessageSyncState';
import { EMPTY_CLOUD_SESSION_ACTIVITY } from '../src/features/cloud/cloudSessionActivity';
import { CloudAuthClient, type CloudAccount, type CloudSyncResponse } from '../src/features/cloud/authClient';
import { cloudSessionVisibilityStorageKey } from '../src/features/cloud/cloudDiffSync';
import { __setSessionBackendForTests } from '../src/features/cloud/session';

// A session deleted on this device leaves its conversation out of the local
// mirror while the server keeps sending cursor events for it. The catch-up
// reloads from a bootstrap once, and never loops.

const ACCOUNT_ID = 'acct_owner';
const UNKNOWN_CONVERSATION = 'CHAT_SYNC_UNKNOWN_CONVERSATION: Chat sync event references an unknown conversation';
const CLIENT_UPDATE_REQUIRED = 'CLIENT_UPDATE_REQUIRED: unknown critical event x';

type ApplyRequest = { bootstrap: boolean; cursor?: string | null; lastStreamSeq?: number | null };
/** The native error string an apply rejects with, or null when the batch commits. */
type ApplyOutcome = (request: ApplyRequest, bootstrapped: boolean) => string | null;

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  assert(predicate(), 'Expected asynchronous state transition');
}

async function fixture(invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  // A cached visibility snapshot lets a catch-up resume from the saved cursor
  // instead of starting with a bootstrap.
  dom.window.localStorage.setItem(cloudSessionVisibilityStorageKey(ACCOUNT_ID), JSON.stringify({ snapshotVersion: 1 }));
  const replacements = { window: dom.window, document: dom.window.document, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke } });
  __setSessionBackendForTests({ load: async () => ({ accountId: ACCOUNT_ID, token: 'synthetic', expiresAt: '2099-01-01' }), save: async () => {}, clear: async () => {} });
  const root = createRoot(document.getElementById('root')!);
  return {
    async render(content: React.ReactNode) { await act(async () => root.render(content)); },
    async close() {
      await act(async () => root.unmount());
      __setSessionBackendForTests(null);
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    },
  };
}

function store<T>(initial: T) {
  const stateRef = { current: initial };
  return { stateRef, setState: (update: React.SetStateAction<T>) => {
    stateRef.current = typeof update === 'function' ? (update as (value: T) => T)(stateRef.current) : update;
  } };
}

const bootstrapResponse: CloudSyncResponse = {
  cursor: 'cursor-head', hasMore: false, events: [],
  chat: { bootstrap: true, protocolVersion: 2, nextCursor: 'cursor-head', lastStreamSeq: 9, conversations: [], messages: [], events: [] },
};

const incrementalResponse: CloudSyncResponse = {
  cursor: 'cursor-next', hasMore: false, events: [],
  chat: {
    bootstrap: false, protocolVersion: 2, nextCursor: 'cursor-next', lastStreamSeq: 6, conversations: [], messages: [],
    events: [{
      stream_seq: 6, event_id: 'event-6', protocol_version: 2, type: 'read_cursor.updated', critical: true,
      conversation_id: 'conversation-1', entity_id: null, entity_version: null, occurred_at: '2026-11-17T08:00:00Z',
      payload: { cursor: { account_id: ACCOUNT_ID, last_delivered_sequence: 3, last_read_sequence: 3 } },
    }],
  },
};

/** Mounts the sync hook against a mirror whose saved cursor is `cursor-stuck`. */
async function mountCatchUp(applyOutcome: ApplyOutcome) {
  const fetched: string[] = [];
  const applied: boolean[] = [];
  let saved = { cursor: 'cursor-stuck', lastStreamSeq: 5 };
  let bootstrapped = false;
  const view = await fixture(async (command, args) => {
    if (command === 'desktop_chat_sync_load') return null;
    if (command === 'desktop_chat_sync_cursor') return { accountId: ACCOUNT_ID, ...saved };
    if (command === 'desktop_chat_sync_apply') {
      const request = (args as { request: ApplyRequest }).request;
      applied.push(request.bootstrap);
      const error = applyOutcome(request, bootstrapped);
      // A native command error reaches the renderer as the rejected string.
      if (error) return Promise.reject(error);
      bootstrapped ||= request.bootstrap;
      saved = { cursor: request.cursor ?? saved.cursor, lastStreamSeq: request.lastStreamSeq ?? saved.lastStreamSeq };
      return { accountId: ACCOUNT_ID, ...saved, changedConversationHeads: [] };
    }
    if (command === 'desktop_chat_sync_conversations' || command === 'desktop_chat_sync_coverage') return [];
    if (command === 'desktop_canonical_prune_missing_cloud_messages') return [];
    throw new Error(`Unexpected native command: ${command}`);
  });
  const client = new CloudAuthClient('http://localhost');
  client.drainChatOutbox = async () => [];
  client.acknowledgeChatDelivery = async () => {};
  client.listChatConversationHistoryPage = async () => { throw new Error('No history page is expected'); };
  client.syncCloudEvents = async (_token, cursor) => {
    fetched.push(cursor);
    return cursor === '0' ? bootstrapResponse : incrementalResponse;
  };
  const coordinator = new CloudSyncCoordinator();
  const stores: CloudMessageSyncStores = {
    messages: { ...store({}), peerReadAtByPeerRef: { current: {} } },
    activity: store(EMPTY_CLOUD_SESSION_ACTIVITY), forks: store({}), pins: store({}), titles: store({}), agents: store({}),
    hiddenSessionIds: store(new Set<string>()), deletedSessionIds: store(new Set<string>()),
    unreadSessionIds: store(new Set<string>()), pinnedSessionIds: store(new Set<string>()),
    mutedSessionIds: store(new Set<string>()), pinnedGroupSpaceIds: store(new Set<string>()),
  };
  let unread: CloudUnreadReadinessSnapshot = { status: 'pending', contextKey: null };
  const setUnreadReadiness = (update: React.SetStateAction<CloudUnreadReadinessSnapshot>) => {
    unread = typeof update === 'function' ? update(unread) : update;
  };
  const refreshCloudAgents = async () => {};
  const cancelledRef = { current: false };
  let state: CloudMessageSyncController | null = null;
  function Probe() {
    state = useCloudMessageSync({ account: { accountId: ACCOUNT_ID } as CloudAccount, client, coordinator,
      bootstrapPeerIds: [ACCOUNT_ID], bootstrapPeerKey: ACCOUNT_ID, contactsSettled: true,
      cloudUnreadContextKey: cloudUnreadReadinessContextKey(ACCOUNT_ID, coordinator.currentGeneration(), ACCOUNT_ID),
      cancelledRef, stores, setUnreadReadiness, refreshCloudAgents });
    return null;
  }
  await view.render(<Probe />);
  return {
    fetched,
    applied,
    state: () => state!,
    /** Waits for the catch-up the mount started to finish, successfully or not. */
    async settle(expectedFetches: number) {
      await waitFor(() => fetched.length === expectedFetches && !coordinator.hasPendingWork() && unread.status !== 'pending');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    },
    async close() {
      cancelledRef.current = true;
      await view.close();
    },
  };
}

/** Runs one explicit catch-up and reports only the fetches and applies it made. */
async function explicitCatchUp(harness: Awaited<ReturnType<typeof mountCatchUp>>) {
  const fetchedBefore = harness.fetched.length;
  const appliedBefore = harness.applied.length;
  let error: unknown = null;
  await act(async () => {
    try { await harness.state().syncCloudCollaborationDiff(); } catch (caught) { error = caught; }
    // Let the background history repair the catch-up started finish too.
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  return { error, fetched: harness.fetched.slice(fetchedBefore), applied: harness.applied.slice(appliedBefore) };
}

test('a batch for a session deleted on this device reloads the mirror from a bootstrap', async () => {
  const harness = await mountCatchUp((request, bootstrapped) => (
    !request.bootstrap && !bootstrapped ? UNKNOWN_CONVERSATION : null
  ));
  try {
    await waitFor(() => harness.state().executionMessagesReady);
    await harness.settle(2);
    assert.deepEqual(harness.fetched, ['cursor-stuck', '0']);
    assert.deepEqual(harness.applied, [false, true]);
    const next = await explicitCatchUp(harness);
    assert.equal(next.error, null, 'the restored mirror applies later batches');
    assert.deepEqual(next.fetched, ['cursor-head']);
    assert.deepEqual(next.applied, [false]);
  } finally { await harness.close(); }
});

test('the bootstrap reload runs at most once per catch-up', async () => {
  const harness = await mountCatchUp(() => UNKNOWN_CONVERSATION);
  try {
    await harness.settle(2);
    assert.deepEqual(harness.fetched, ['cursor-stuck', '0']);
    const next = await explicitCatchUp(harness);
    // The bootstrap's own failure is final and surfaces unchanged.
    assert.match(String(next.error), /CHAT_SYNC_UNKNOWN_CONVERSATION/);
    assert.deepEqual(next.fetched, ['cursor-stuck', '0']);
    assert.deepEqual(next.applied, [false, true]);
    assert.equal(harness.state().executionMessagesReady, false);
  } finally { await harness.close(); }
});

test('a batch the mirror accepts never reloads', async () => {
  const harness = await mountCatchUp(() => null);
  try {
    await waitFor(() => harness.state().executionMessagesReady);
    await harness.settle(1);
    assert.deepEqual(harness.fetched, ['cursor-stuck']);
    const next = await explicitCatchUp(harness);
    assert.equal(next.error, null);
    assert.deepEqual(next.fetched, ['cursor-next']);
    assert.deepEqual(next.applied, [false]);
    assert.ok(!harness.fetched.includes('0'));
  } finally { await harness.close(); }
});

test('other local apply failures surface without a reload', async () => {
  const harness = await mountCatchUp(() => CLIENT_UPDATE_REQUIRED);
  try {
    await harness.settle(1);
    const next = await explicitCatchUp(harness);
    assert.match(String(next.error), /CLIENT_UPDATE_REQUIRED: unknown critical event x/);
    assert.deepEqual(next.fetched, ['cursor-stuck']);
    assert.deepEqual(next.applied, [false]);
    assert.ok(!harness.fetched.includes('0'));
  } finally { await harness.close(); }
});
