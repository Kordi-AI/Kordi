import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';

import { ACCOUNT_HINT_EVENT_TYPES } from '../src/features/cloud/accountHintEvents';
import type { ChatSyncEvent } from '../src/features/cloud/chatSyncTypes';
import { chatSyncBatchMayChangeThreadAttention } from '../src/features/cloud/threadAttentionSyncTrigger';
import {
  applyChatSyncLocalBatch,
  CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT,
  type ChatSyncLocalStateChangedEvent,
} from '../src/lib/desktopChatSync';

const viewer = 'acct_viewer';
const other = 'acct_other';

function event(type: string, payload: Record<string, unknown> = {}): ChatSyncEvent {
  return {
    stream_seq: 7, event_id: `event-${type}`, protocol_version: 2, type, critical: true,
    conversation_id: 'conversation-1', entity_id: 'conversation-1', entity_version: null,
    occurred_at: '2026-11-10T10:00:00Z', payload,
  };
}

function cursor(accountId: string) {
  return { cursor: { conversation_id: 'conversation-1', account_id: accountId, last_delivered_sequence: 9, last_read_sequence: 9 } };
}

function mayChange(...events: ChatSyncEvent[]) {
  return chatSyncBatchMayChangeThreadAttention({ accountId: viewer, bootstrap: false, events });
}

// Every event type the desktop client maps or handles, with the decision the
// server's attention query implies (thread_attention.rs).
const REFETCH = [
  'message.created', 'message.updated', 'message.deleted', 'message.hidden',
  'generation.updated', 'generation.completed', 'generation.failed',
  'conversation.created', 'conversation.updated', 'membership.updated', 'membership.removed',
  'session.muted', 'session.unmuted', 'session.deleted', 'account.directory.changed',
];
const NEUTRAL = [
  'delivery_cursor.updated', 'reaction.updated', 'conversation.preferences.updated',
  'session.hidden', 'session.unhidden', 'session.pinned', 'session.unpinned', 'session.pin.updated',
  'session.marked_unread', 'session.unmarked_unread', 'session.visibility.snapshot', 'session-forked',
  'group_space.pinned', 'group_space.unpinned', 'account.profile.updated',
  'agent.definition.upserted', 'agent.definition.archived', 'agent.directory.changed',
  'provider-auth.updated', 'task.upsert', 'artifact.upsert', 'artifact.archived',
  'device.added', 'device.confirmed', 'device.revoked', 'device.renamed',
  'call.created', 'call.updated', 'document.updated', 'digest.updated',
  ...ACCOUNT_HINT_EVENT_TYPES,
];

test('every event that changes an attention input refetches', () => {
  for (const type of REFETCH) assert.equal(mayChange(event(type)), true, type);
});

test('events that touch nothing the attention query reads do not refetch', () => {
  for (const type of NEUTRAL) assert.equal(mayChange(event(type)), false, type);
  assert.equal(mayChange(event('delivery_cursor.updated', cursor(viewer))), false, 'own delivery');
  assert.equal(mayChange(event('delivery_cursor.updated', cursor(other))), false, 'another delivery');
});

test('only the viewer\'s own read cursor refetches', () => {
  assert.equal(mayChange(event('read_cursor.updated', cursor(viewer))), true, 'own read moves last_read_sequence');
  assert.equal(mayChange(event('read_cursor.updated', {
    ...cursor(other), read_outbox: { conversation_id: 'conversation-1', sequence: 9 },
  })), false, 'another member\'s read reaches an author as a watermark');
  assert.equal(mayChange(event('read_cursor.updated', cursor(` ${viewer} `))), true, 'account ids compare trimmed');
  assert.equal(mayChange(event('read_cursor.updated')), true, 'a read without a reader refetches');
  assert.equal(mayChange(event('read_cursor.updated', { cursor: { account_id: '' } })), true);
});

test('an unknown event type refetches', () => {
  assert.equal(mayChange(event('conversation.something_new')), true);
  assert.equal(mayChange(event('delivery_cursor.updated'), event('conversation.something_new')), true);
});

test('a batch refetches when any one event can change attention', () => {
  assert.equal(mayChange(event('delivery_cursor.updated', cursor(viewer)), event('read_cursor.updated', cursor(other))), false);
  assert.equal(mayChange(event('delivery_cursor.updated', cursor(viewer)), event('message.created')), true);
});

test('bootstraps and history pages without events refetch', () => {
  assert.equal(chatSyncBatchMayChangeThreadAttention({ accountId: viewer, bootstrap: true, events: [] }), true);
  assert.equal(chatSyncBatchMayChangeThreadAttention({
    accountId: viewer, bootstrap: true, events: [event('session.visibility.snapshot')],
  }), true, 'a sync gap or reset arrives as a bootstrap');
  assert.equal(chatSyncBatchMayChangeThreadAttention({ accountId: viewer, bootstrap: false }), true);
  assert.equal(chatSyncBatchMayChangeThreadAttention({ accountId: viewer, bootstrap: false, events: [] }), true);
});

test('a native commit announces the batch it committed', async () => {
  const previous = globalThis.window;
  Object.assign(globalThis, { window: new EventTarget() });
  mockIPC(() => ({ accountId: viewer, cursor: 'next', lastStreamSeq: 8, changedConversationHeads: [] }));
  const details: unknown[] = [];
  window.addEventListener(CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT, (published) => {
    details.push((published as ChatSyncLocalStateChangedEvent).detail);
  });
  try {
    const request = { accountId: viewer, bootstrap: false, events: [event('delivery_cursor.updated', cursor(viewer))] };
    await applyChatSyncLocalBatch(request);
    assert.deepEqual(details, [{ batch: request }]);
  } finally {
    clearMocks();
    Object.assign(globalThis, { window: previous });
  }
});
