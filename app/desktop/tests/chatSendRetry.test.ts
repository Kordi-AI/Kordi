import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { ChatSyncMessage } from '../src/features/cloud/authClient';
import { buildCloudAuthError, CloudAuthError, parseRetryAfterSeconds } from '../src/features/cloud/cloudAuthError';
import {
  CHAT_SEND_RETRY_AFTER_MAX_MS,
  CHAT_SEND_RETRY_DELAYS_MS,
  chatSendQueuedForRetry,
  chatSendRetryAfterMs,
  createChatSendRetryGate,
} from '../src/features/cloud/chatSendRetry';
import { ChatSyncMessageDelivery } from '../src/features/cloud/chatSyncMessageDelivery';
import { ChatSyncState } from '../src/features/cloud/chatSyncState';
import { CloudGroupOutbox, cloudGroupOutboxDeliveryStatus } from '../src/features/cloud/cloudGroupOutbox';
import { terminalCollaborationRetryFailure } from '../src/features/chat/messageActions/collaborationRetry';
import type { ChatSyncOutboxPayload } from '../src/lib/desktopChatSync';
import { conversation, message } from './helpers/chatSyncCanonicalFixtures';
import { MemoryPersistence, entry } from './helpers/cloudGroupOutboxFixtures';

const timedOut = () => new CloudAuthError('network_error', 'Cloud request timed out. Check your connection and try again.', 0);
const rateLimited = (seconds: number) => new CloudAuthError('rate_limited', 'Too many requests.', 429, seconds);

test('Retry-After is read as seconds or an HTTP date', () => {
  const now = Date.parse('2026-11-10T08:00:00Z');
  assert.equal(parseRetryAfterSeconds('120', now), 120);
  assert.equal(parseRetryAfterSeconds(' 0 ', now), 0);
  assert.equal(parseRetryAfterSeconds('Tue, 10 Nov 2026 08:00:45 GMT', now), 45);
  assert.equal(parseRetryAfterSeconds('Tue, 10 Nov 2026 07:59:00 GMT', now), 0, 'a date in the past means now');
  assert.equal(parseRetryAfterSeconds('soon', now), undefined);
  assert.equal(parseRetryAfterSeconds('', now), undefined);
  assert.equal(parseRetryAfterSeconds(null, now), undefined);
  const unavailable = buildCloudAuthError(503, { error: { code: 'SERVER_ERROR', message: 'Down' } }, 'Could not send.', '7');
  assert.equal(unavailable.retryAfterSeconds, 7);
});

test('only a 429 or 503 wait is honored, and a huge one is capped', () => {
  assert.equal(chatSendRetryAfterMs(rateLimited(30)), 30_000);
  assert.equal(chatSendRetryAfterMs(new CloudAuthError('server_error', 'Down', 503, 2)), 2_000);
  assert.equal(chatSendRetryAfterMs(rateLimited(86_400)), CHAT_SEND_RETRY_AFTER_MAX_MS);
  assert.equal(chatSendRetryAfterMs(new CloudAuthError('server_error', 'Oops', 500, 10)), null);
  assert.equal(chatSendRetryAfterMs(new CloudAuthError('rate_limited', 'Slow down', 429)), null);
  assert.equal(chatSendRetryAfterMs(timedOut()), null);
});

/** A server that stores each client message id once and returns the stored copy for a repeat. */
function fakeChatServer(failures: Array<() => Error>) {
  const stored = new Map<string, ChatSyncMessage>();
  let posts = 0;
  const send = async <T>(path: string, init: RequestInit): Promise<T> => {
    assert.match(path, /\/messages$/);
    posts += 1;
    const body = JSON.parse(String(init.body)) as { client_message_id: string };
    let row = stored.get(body.client_message_id);
    if (!row) {
      row = { ...message, id: `stored-${stored.size + 1}`, client_message_id: body.client_message_id, conversation_sequence: 9 };
      stored.set(body.client_message_id, row);
    }
    // The server committed the message; the reply is what gets lost.
    const failure = failures.shift();
    if (failure) throw failure();
    return { message: row } as T;
  };
  const state = new ChatSyncState(send, () => 'acct_b', () => {}, (error) => (error instanceof CloudAuthError ? error.status : null));
  state.ensureConversation = async () => conversation;
  return { state, stored, posts: () => posts };
}

/** The desktop outbox's rules: a repeat enqueue is a no-op, a retryable failure stays pending. */
function fakeOutbox() {
  const operations = new Map<string, { payload: ChatSyncOutboxPayload; status: 'pending' | 'failed' }>();
  const completed: string[] = [];
  let dueReads = 0;
  const outbox = {
    enqueue: async (_accountId: string, operationId: string, payload: ChatSyncOutboxPayload) => {
      if (!operations.has(operationId)) operations.set(operationId, { payload, status: 'pending' });
    },
    due: async (accountId: string) => {
      dueReads += 1;
      return [...operations].filter(([, operation]) => operation.status === 'pending').map(([operationId, operation]) => ({
        accountId, operationId, payload: operation.payload, attemptCount: 0, nextAttemptAtMs: 0, lastError: null,
      }));
    },
    complete: async (_accountId: string, operationId: string) => { completed.push(operationId); operations.delete(operationId); },
    fail: async (_accountId: string, operationId: string, _error: string, retryable: boolean) => {
      const operation = operations.get(operationId);
      if (operation) operation.status = retryable ? 'pending' : 'failed';
    },
  };
  return {
    outbox: outbox as unknown as ConstructorParameters<typeof ChatSyncMessageDelivery>[1],
    operations,
    completed,
    dueReads: () => dueReads,
  };
}

test('a direct send that timed out after the server stored it ends as sent exactly once', async () => {
  const server = fakeChatServer([timedOut]);
  const queue = fakeOutbox();
  const delivery = new ChatSyncMessageDelivery(server.state, queue.outbox, createChatSendRetryGate(() => 0));
  const clientMessageId = '0b9b7a52-2f0e-4c7a-9a55-7d7d2f3c1a01';
  const error = await delivery.sendMessage('synthetic-token', 'acct_a', 'hello', { accountId: 'acct_b', clientMessageId })
    .then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof CloudAuthError);
  assert.equal(chatSendQueuedForRetry(error), true, 'the outcome is unknown, not failed');
  assert.equal(terminalCollaborationRetryFailure({ error, conversationId: 'c', messageId: clientMessageId }), null);
  assert.equal(queue.operations.get(clientMessageId)?.status, 'pending');

  const delivered = await delivery.drainChatOutbox('synthetic-token', 'acct_b');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.messageId, 'stored-1', 'the repeat returns the stored message');
  assert.equal(server.stored.size, 1, 'the server holds one copy');
  assert.deepEqual(queue.completed, [clientMessageId]);
  assert.deepEqual(await delivery.drainChatOutbox('synthetic-token', 'acct_b'), []);
  assert.equal(server.posts(), 2);
});

test('catch-up does not resend an outbox entry whose original send is still in flight', async () => {
  const server = fakeChatServer([]);
  const queue = fakeOutbox();
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const sending = new Promise<void>((resolve) => { started = resolve; });
  let lookups = 0;
  server.state.ensureConversation = async () => {
    if (++lookups === 1) {
      started();
      await held;
    }
    return conversation;
  };
  // Conversation clients create separate delivery wrappers for send and drain.
  const initial = new ChatSyncMessageDelivery(server.state, queue.outbox).sendMessage(
    'synthetic-token', 'acct_a', 'hello', {
      accountId: 'acct_b', clientMessageId: '0b9b7a52-2f0e-4c7a-9a55-7d7d2f3c1a04',
    },
  );
  await sending;
  try {
    const catchUp = new ChatSyncMessageDelivery(server.state, queue.outbox);
    assert.deepEqual(await catchUp.drainChatOutbox('synthetic-token', 'acct_b'), []);
    assert.equal(server.posts(), 0, 'the original send still owns this pending entry');
  } finally {
    release();
    await initial;
  }
  assert.equal(server.posts(), 1);
  assert.equal(queue.completed.length, 1);
});

test('a refused send is not left looking queued', async () => {
  const server = fakeChatServer([() => new CloudAuthError('unknown', "You can't message this person.", 403)]);
  const queue = fakeOutbox();
  const delivery = new ChatSyncMessageDelivery(server.state, queue.outbox, createChatSendRetryGate(() => 0));
  const clientMessageId = '0b9b7a52-2f0e-4c7a-9a55-7d7d2f3c1a02';
  const error = await delivery.sendMessage('synthetic-token', 'acct_a', 'hello', { accountId: 'acct_b', clientMessageId })
    .then(() => null, (caught: unknown) => caught);
  assert.equal(chatSendQueuedForRetry(error), false);
  assert.ok(terminalCollaborationRetryFailure({ error, conversationId: 'c', messageId: clientMessageId }));
  assert.equal(queue.operations.get(clientMessageId)?.status, 'failed');
});

test('a delayed outbox read does not replay a send completed after its pending snapshot', async () => {
  const server = fakeChatServer([]);
  const queue = fakeOutbox();
  let releaseSend!: () => void;
  let started!: () => void;
  const heldSend = new Promise<void>((resolve) => { releaseSend = resolve; });
  const sending = new Promise<void>((resolve) => { started = resolve; });
  server.state.ensureConversation = async () => { started(); await heldSend; return conversation; };
  const initial = new ChatSyncMessageDelivery(server.state, queue.outbox).sendMessage(
    'synthetic-token', 'acct_a', 'hello', {
      accountId: 'acct_b', clientMessageId: '0b9b7a52-2f0e-4c7a-9a55-7d7d2f3c1a05',
    },
  );
  await sending;
  let releaseRead!: () => void;
  let snapshotTaken!: () => void;
  const heldRead = new Promise<void>((resolve) => { releaseRead = resolve; });
  const reading = new Promise<void>((resolve) => { snapshotTaken = resolve; });
  const outbox = queue.outbox!;
  const catchUp = new ChatSyncMessageDelivery(server.state, {
    ...outbox,
    due: async (...args) => {
      const snapshot = await outbox.due(...args);
      snapshotTaken();
      await heldRead;
      return snapshot;
    },
  }).drainChatOutbox('synthetic-token', 'acct_b');
  await reading;
  releaseSend();
  try {
    await initial;
  } finally {
    releaseRead();
  }
  assert.deepEqual(await catchUp, []);
  assert.equal(server.posts(), 1);
  assert.equal(queue.completed.length, 1);
});

test('queued direct sends wait out a Retry-After before trying again', async () => {
  let now = 0;
  const server = fakeChatServer([() => rateLimited(30)]);
  const queue = fakeOutbox();
  const delivery = new ChatSyncMessageDelivery(server.state, queue.outbox, createChatSendRetryGate(() => now));
  await assert.rejects(delivery.sendMessage('synthetic-token', 'acct_a', 'hello', {
    accountId: 'acct_b', clientMessageId: '0b9b7a52-2f0e-4c7a-9a55-7d7d2f3c1a03',
  }));
  now = 29_000;
  assert.deepEqual(await delivery.drainChatOutbox('synthetic-token', 'acct_b'), []);
  assert.equal(queue.dueReads(), 0, 'nothing is sent while the server asked to wait');
  assert.equal(server.posts(), 1);
  now = 30_000;
  const delivered = await delivery.drainChatOutbox('synthetic-token', 'acct_b');
  assert.equal(delivered.length, 1);
  assert.equal(server.stored.size, 1);
});

test('group and direct sends share one retry schedule and keep retrying transient failures', async () => {
  const rust = readFileSync(
    new URL('../src-tauri/src/canonical_sessions/chat_sync/outbox.rs', import.meta.url),
    'utf8',
  );
  const schedule = rust.match(/let delay_ms = \[([^\]]+)\]/)?.[1]
    ?.split(',').map((value) => Number(value.replace(/_i64|_/g, '').trim()));
  assert.deepEqual(schedule, [...CHAT_SEND_RETRY_DELAYS_MS], 'the desktop outbox uses the same waits');
  assert.match(rust, /if request\.retryable \{\s*"pending"/, 'a retryable direct send never gives up');

  const outbox = new CloudGroupOutbox('acct_me', new MemoryPersistence());
  await outbox.restore();
  await outbox.enqueue(entry());
  let nowMs = 100;
  const waits: number[] = [];
  for (let round = 0; round < 12; round += 1) {
    const outcome = await outbox.deliver('msg:canonical:one', async () => { throw timedOut(); }, { nowMs, force: true });
    assert.ok(outcome);
    waits.push(outcome.nextAttemptAtMs - nowMs);
    nowMs = outcome.nextAttemptAtMs;
    assert.deepEqual(outcome.pendingRecipientIds, ['acct_a', 'acct_b'], `round ${round + 1} keeps both recipients queued`);
    assert.equal(outcome.exhaustedRecipientIds, undefined);
    assert.equal(cloudGroupOutboxDeliveryStatus(outcome).status, 'sending');
  }
  assert.deepEqual(waits, [1_000, 2_000, 5_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000]);
});

test('a group send waits out a Retry-After longer than its next scheduled try', async () => {
  const outbox = new CloudGroupOutbox('acct_me', new MemoryPersistence());
  await outbox.restore();
  await outbox.enqueue(entry());
  const outcome = await outbox.deliver('msg:canonical:one', async ({ recipientId }) => {
    if (recipientId === 'acct_b') throw rateLimited(20);
    throw timedOut();
  }, { nowMs: 1_000, force: true });
  assert.equal(outcome?.nextAttemptAtMs, 21_000);
  assert.deepEqual(await outbox.deliverDue(async () => { throw new Error('must wait'); }, 20_999), []);
});

test('a group send that timed out after the server stored it is delivered once, never failed', async () => {
  const server = new Map<string, number>();
  const statuses: string[] = [];
  const outbox = new CloudGroupOutbox('acct_me', new MemoryPersistence());
  await outbox.restore();
  await outbox.enqueue(entry());
  const send = async ({ clientMessageId }: { clientMessageId: string }) => {
    const copies = server.get(clientMessageId) ?? 0;
    // Stored on the first try either way: a repeat finds it instead of adding one.
    if (copies === 0) server.set(clientMessageId, 1);
    if (copies === 0) throw timedOut();
    return { clientMessageId };
  };
  const first = await outbox.deliver('msg:canonical:one', send, { nowMs: 100, force: true });
  statuses.push(cloudGroupOutboxDeliveryStatus(first!).status);
  const [second] = await outbox.deliverDue(send, first!.nextAttemptAtMs);
  statuses.push(cloudGroupOutboxDeliveryStatus(second!).status);
  assert.deepEqual(statuses, ['sending', 'delivered']);
  assert.deepEqual(second?.deliveredRecipientIds.sort(), ['acct_a', 'acct_b']);
  assert.deepEqual([...server.values()], [1, 1], 'one stored copy per recipient');
});
