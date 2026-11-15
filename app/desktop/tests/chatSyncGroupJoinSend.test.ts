// Sending into a group right after joining it from Contacts › Requests. The joiner's device builds
// its participant list from what it has read, which can miss someone who joined a moment later on
// the server. A message must post at once anyway, and must never try to change who is in the group.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudAuthClient } from '../src/features/cloud/authClient';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import { createChatSendRetryGate } from '../src/features/cloud/chatSendRetry';
import { ChatSyncMessageDelivery } from '../src/features/cloud/chatSyncMessageDelivery';
import { ChatSyncState } from '../src/features/cloud/chatSyncState';
import { cloudGroupOutboxMessageOptions } from '../src/features/cloud/cloudGroupOutboxAttachments';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { conversation, message } from './helpers/chatSyncCanonicalFixtures';

const member = (accountId: string, role: string) => ({
  account_id: accountId, role, membership_state: 'active', version: 1,
  last_delivered_sequence: 0, last_read_sequence: 0,
  joined_at: '2026-11-14T17:35:00Z', left_at: null,
});

// Chen owns the group; Alex and Bea joined from invitations, Bea a few seconds after Alex.
function group(viewer: string) {
  return {
    ...conversation,
    kind: 'group' as const,
    legacy_session_id: 'session:group:joined',
    preferences: { ...conversation.preferences, account_id: viewer },
    members: [member('acct_chen', 'owner'), member('acct_alex', 'member'), member('acct_bea', 'member')],
  };
}

function recordingClient(viewer: string) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async (input, init) => {
      const url = input.toString();
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : null });
      if (url.endsWith('/sync/bootstrap')) {
        return new Response(JSON.stringify({
          protocol_version: 2,
          conversations: [group(viewer)],
          session_visibility: { hiddenSessionIds: [], deletedSessionIds: [], pinnedSessionIds: [], mutedSessionIds: [], unreadSessionIds: [], pinnedGroupSpaceIds: [] },
          latest_messages: [],
          next_cursor: 'opaque',
          last_stream_seq: 1,
          server_time: '2026-11-14T17:36:00Z',
        }), { status: 200 });
      }
      if (url.endsWith('/members')) {
        return new Response(JSON.stringify({ errorCode: 'forbidden', message: 'Forbidden.' }), { status: 403 });
      }
      return new Response(JSON.stringify({ message }), { status: 201 });
    },
  });
  return { client, calls };
}

function envelope(kind: 'group-message' | 'group-update', sender: string, participants: string[], leaves: string[] = []) {
  return `kordi-cloud-group:${Buffer.from(JSON.stringify({
    kind,
    groupId: 'session:group:joined',
    participants: participants.map((accountId) => ({ accountId })),
    ...(leaves.length ? { memberLeaves: leaves.map((accountId, index) => ({ eventId: `leave-${index}`, accountId, createdAtMs: 1 })) } : {}),
    message: kind === 'group-message' ? { id: 'msg:ui:hi', senderAccountId: sender, text: 'hi', createdAtMs: 1 } : null,
  })).toString('base64url')}`;
}

test('a member who just joined posts at once, with a list that does not show the next joiner yet', async () => {
  const { client, calls } = recordingClient('acct_alex');
  await client.syncCloudEvents('token', '0');
  await client.sendMessage('token', 'acct_chen', envelope('group-message', 'acct_alex', ['acct_alex', 'acct_chen']), {
    sessionId: 'session:group:joined',
    conversationKind: 'group',
    memberAccountIds: ['acct_alex', 'acct_chen'],
  });
  assert.equal(calls.some((call) => call.url.endsWith('/members')), false);
  assert.equal(calls.filter((call) => call.url.endsWith('/messages') && call.method === 'POST').length, 1);
});

test("an owner's message never removes people who joined on the server", async () => {
  const { client, calls } = recordingClient('acct_chen');
  await client.syncCloudEvents('token', '0');
  await client.sendMessage('token', 'acct_alex', envelope('group-message', 'acct_chen', ['acct_chen']), {
    sessionId: 'session:group:joined',
    conversationKind: 'group',
    memberAccountIds: ['acct_chen'],
  });
  assert.equal(calls.some((call) => call.url.endsWith('/members')), false);
  assert.equal(calls.filter((call) => call.url.endsWith('/messages') && call.method === 'POST').length, 1);
});

test("an owner's removal takes out only the person it names, not people missing from their list", async () => {
  const { client, calls } = recordingClient('acct_chen');
  await client.syncCloudEvents('token', '0');
  await client.sendMessage('token', 'acct_alex', envelope('group-update', 'acct_chen', ['acct_chen'], ['acct_alex']), {
    sessionId: 'session:group:joined',
    conversationKind: 'group',
    memberAccountIds: ['acct_chen'],
  }).catch(() => undefined);
  const membership = calls.find((call) => call.url.endsWith('/members'));
  assert.ok(membership);
  assert.deepEqual(membership.body && (membership.body as { member_account_ids: string[] }).member_account_ids.sort(), ['acct_bea', 'acct_chen']);
  assert.equal((membership.body as { replace: boolean }).replace, true);
});

test('a member never asks to change who is in the group, even with a membership control', async () => {
  const { client, calls } = recordingClient('acct_alex');
  await client.syncCloudEvents('token', '0');
  await client.sendMessage('token', 'acct_chen', envelope('group-update', 'acct_alex', ['acct_alex', 'acct_chen', 'acct_dee']), {
    sessionId: 'session:group:joined',
    conversationKind: 'group',
    memberAccountIds: ['acct_alex', 'acct_chen', 'acct_dee'],
  });
  assert.equal(calls.some((call) => call.url.endsWith('/members')), false);
});

/** JSON with sorted keys, as the desktop outbox stores and compares a payload. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

test('a queued group message is retried with the same request as its first try', async () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:joined',
    groupSpaceId: 'session:group:joined',
    groupTitle: null,
    createdByAccountId: 'acct_alex',
    actor: { accountId: 'acct_alex', displayName: 'Alex', role: 'person' },
    participants: [
      { accountId: 'acct_alex', displayName: 'Alex', role: 'self' },
      { accountId: 'acct_chen', displayName: 'Chen', role: 'admin' },
    ],
    message: { id: 'msg:ui:hi', senderAccountId: 'acct_alex', text: 'hi', createdAtMs: 1 },
  });
  // The desktop outbox refuses a second enqueue of the same operation with a changed payload.
  const queued = new Map<string, string>();
  const outbox = {
    enqueue: async (_accountId: string, operationId: string, payload: unknown) => {
      const json = canonicalJson(payload);
      const existing = queued.get(operationId);
      if (existing !== undefined && existing !== json) throw new Error('IDEMPOTENCY_KEY_REUSED: pending operation payload changed');
      queued.set(operationId, json);
    },
    due: async () => [],
    complete: async (_accountId: string, operationId: string) => { queued.delete(operationId); },
    fail: async () => {},
  };
  let attempts = 0;
  const state = new ChatSyncState(
    async <T>() => {
      attempts += 1;
      if (attempts === 1) throw new CloudAuthError('network_error', 'Cloud request timed out.', 0);
      return { message } as T;
    },
    () => 'acct_alex',
    () => {},
    (error) => (error instanceof CloudAuthError ? error.status : null),
  );
  state.activeAccountId = 'acct_alex';
  state.ensureConversation = async () => group('acct_alex');
  const delivery = new ChatSyncMessageDelivery(state, outbox, createChatSendRetryGate());
  const shared = { sessionId: 'session:group:joined', attachments: [], clientCreatedAt: '2026-11-14T17:36:04.337Z', clientMessageId: 'cm-hi' };
  // The first try, as the group sender makes it.
  await assert.rejects(delivery.sendMessage('token', 'acct_chen', body, {
    ...shared, ...cloudGroupOutboxMessageOptions(body), conversationKind: 'group', memberAccountIds: ['acct_chen'],
  }));
  // The retry, as the group outbox makes it.
  await delivery.sendMessage('token', 'acct_chen', body, {
    ...shared, ...cloudGroupOutboxMessageOptions(body), conversationKind: 'group', memberAccountIds: ['acct_chen', 'acct_alex'],
  });
  assert.equal(attempts, 2);
  assert.equal(queued.size, 0, 'delivered and taken off the queue');
});
