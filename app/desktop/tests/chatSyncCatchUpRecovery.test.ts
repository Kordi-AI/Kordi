import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient, type CloudSyncResponse } from '../src/features/cloud/authClient';
import { buildCloudAuthError, CloudAuthError } from '../src/features/cloud/cloudAuthError';
import { syncCloudDiffOnce } from '../src/features/cloud/cloudDiffSync';
import { chatSyncCursorExpired } from '../src/features/cloud/cloudSyncCursorProgress';
import { conversation, message } from './helpers/chatSyncCanonicalFixtures';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(
  JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json', ...headers } },
);

const bootstrapBody = {
  protocol_version: 2,
  conversations: [conversation],
  session_visibility: { hiddenSessionIds: [], deletedSessionIds: [], pinnedSessionIds: [], mutedSessionIds: [], unreadSessionIds: [], pinnedGroupSpaceIds: [] },
  latest_messages: [message],
  next_cursor: 'cursor-after-bootstrap',
  last_stream_seq: 90,
  server_time: '2026-11-10T08:00:00Z',
};

const expiredBody = {
  error: { code: 'SYNC_CURSOR_EXPIRED', message: 'The sync cursor is older than retained events.', details: { bootstrap_required: true } },
};

function scriptedClient(syncResponse: () => Response | Promise<Response>) {
  const calls: string[] = [];
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async (input) => {
      const url = input.toString();
      calls.push(url.replace('http://srv', ''));
      if (url.endsWith('/v2/chat/sync/bootstrap')) return json(200, bootstrapBody);
      return syncResponse();
    },
  });
  return { client, calls };
}

test('a network error, a timeout or a server error during catch-up keeps the cursor and never reloads', async () => {
  const failures: Array<[string, () => Response | Promise<Response>]> = [
    ['network', () => { throw new TypeError('Load failed'); }],
    ['bad gateway', () => json(502, { error: { code: 'SERVER_ERROR', message: 'Bad gateway' } })],
    ['unavailable', () => json(503, { error: { code: 'SERVER_ERROR', message: 'Unavailable' } }, { 'retry-after': '3' })],
    ['server error', () => json(500, { error: { code: 'SERVER_ERROR', message: 'The chat operation could not be completed.' } })],
  ];
  for (const [label, failure] of failures) {
    const { client, calls } = scriptedClient(failure);
    await assert.rejects(client.syncCloudEvents('synthetic-token', 'cursor-A', 500), CloudAuthError, label);
    assert.deepEqual(calls, ['/v2/chat/sync?cursor=cursor-A&limit=500'], `${label}: no bootstrap download`);
  }
});

test('only the server saying the cursor expired starts a full reload', async () => {
  for (const [label, response] of [
    ['expired', () => json(409, expiredBody)],
    ['stream integrity', () => json(500, { error: { code: 'CHAT_SYNC_INVARIANT_VIOLATION', message: 'gap', details: { bootstrap_required: true } } })],
  ] as const) {
    const { client, calls } = scriptedClient(response);
    const result = await client.syncCloudEvents('synthetic-token', 'cursor-A', 500);
    assert.equal(result.chat?.bootstrap, true, label);
    assert.equal(result.cursor, 'cursor-after-bootstrap');
    assert.deepEqual(calls, ['/v2/chat/sync?cursor=cursor-A&limit=500', '/v2/chat/sync/bootstrap'], label);
  }
});

test('the expired-cursor signal survives error mapping', () => {
  const expired = buildCloudAuthError(409, expiredBody, 'Could not sync.');
  assert.equal(expired.serverCode, 'SYNC_CURSOR_EXPIRED');
  assert.equal(expired.bootstrapRequired, true);
  assert.equal(chatSyncCursorExpired(expired), true);
  const failed = buildCloudAuthError(500, { error: { code: 'SERVER_ERROR', message: 'x' } }, 'Could not sync.');
  assert.equal(failed.bootstrapRequired, undefined);
  assert.equal(chatSyncCursorExpired(failed), false);
  assert.equal(chatSyncCursorExpired(new CloudAuthError('network_error', 'Cloud request timed out.', 0)), false);
  assert.equal(chatSyncCursorExpired(new Error('offline')), false);
  // An older reply without a body is still the sync route's only 409.
  assert.equal(chatSyncCursorExpired(new CloudAuthError('unknown', 'Conflict', 409)), true);
});

function diffInput(cursor: () => string, fetchEvents: (cursor: string) => Promise<CloudSyncResponse>, commits: string[]) {
  return {
    accountId: 'acct_owner',
    messagesByPeer: {},
    loadCursor: async () => cursor(),
    commitResponse: async (response: CloudSyncResponse) => { commits.push(response.cursor); },
    fetchEvents,
  };
}

test('a failed catch-up is retried from the same saved cursor', async () => {
  let saved = 'cursor-A';
  const requested: string[] = [];
  const commits: string[] = [];
  let failNext = true;
  const fetchEvents = async (cursor: string): Promise<CloudSyncResponse> => {
    requested.push(cursor);
    if (failNext) {
      failNext = false;
      throw new CloudAuthError('network_error', 'Cloud request timed out.', 0);
    }
    return { cursor: 'cursor-B', hasMore: false, events: [] };
  };
  await assert.rejects(syncCloudDiffOnce(diffInput(() => saved, fetchEvents, commits)), /timed out/);
  assert.deepEqual(commits, [], 'nothing is committed and the cursor is kept');
  const result = await syncCloudDiffOnce(diffInput(() => saved, fetchEvents, commits));
  saved = result.cursor;
  assert.deepEqual(requested, ['cursor-A', 'cursor-A']);
  assert.equal(result.fallbackRequired, false);
  assert.equal(saved, 'cursor-B');
});

test('a catch-up that hears the cursor expired asks for the reload', async () => {
  const commits: string[] = [];
  const result = await syncCloudDiffOnce(diffInput(
    () => 'cursor-A',
    async () => { throw buildCloudAuthError(409, expiredBody, 'Could not sync.'); },
    commits,
  ));
  assert.equal(result.fallbackRequired, true);
  assert.equal(result.cursor, 'cursor-A');
  assert.deepEqual(commits, []);
});
