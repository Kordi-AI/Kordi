import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import { refreshAppSession } from '../src/features/cloud/appSignIn/appSignInClient';
import { bearerCredential, CloudAuthError } from '../src/features/cloud/cloudAuthError';
import {
  deletedAccountId,
  endDeletedCloudSession,
  endSessionIfAccountDeletedClose,
  isAccountDeletedClose,
  isAccountDeletedError,
  type DeletedSessionTeardown,
} from '../src/features/cloud/cloudAccountDeletion';
import { accountLocalStorageKeys, eraseCloudAccountLocalData } from '../src/features/cloud/cloudAccountLocalData';
import { endCloudSessionIfRejected } from '../src/features/cloud/cloudSessionRejection';
import {
  __setSessionBackendForTests,
  CLOUD_SESSION_SIGNED_OUT_EVENT,
  loadSession,
  type SessionStorageBackend,
  type StoredSession,
} from '../src/features/cloud/session';

const deleted = () => new CloudAuthError('account_deleted', 'This account was deleted.', 401, undefined, { serverCode: 'account_deleted' });

function memoryBackend(initial: StoredSession | null, refresh?: SessionStorageBackend['refresh']) {
  const state = { session: initial, clears: 0 };
  const backend: SessionStorageBackend = {
    load: async () => state.session,
    save: async (session) => { state.session = session; },
    clear: async () => { state.clears += 1; state.session = null; },
    ...(refresh ? { refresh } : {}),
  };
  return { state, backend };
}

type Harness = { dom: JSDOM; signedOut: () => number; storage: Storage; until: (condition: () => boolean, label: string) => Promise<void> };

async function withWindow<T>(run: (harness: Harness) => Promise<T>, extra: Record<string, unknown> = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  Object.assign(dom.window, extra);
  const replacements = { window: dom.window, document: dom.window.document, Event: dom.window.Event };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let signedOut = 0;
  dom.window.addEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, () => { signedOut += 1; });
  const until = async (condition: () => boolean, label: string) => {
    for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(condition(), label);
  };
  try {
    return await run({ dom, signedOut: () => signedOut, storage: dom.window.localStorage, until });
  } finally {
    __setSessionBackendForTests(null);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

function seedStorage(storage: Storage, accountId: string) {
  storage.setItem(`kordi.cloud.syncCursor.chat:${accountId}`, 'cursor');
  storage.setItem(`kordi.organization.selected.${accountId}`, 'org_example');
  storage.setItem(`kordi.digest.calendarSync.preferences:${accountId}`, '{}');
  storage.setItem('kordi.documentReaderKey.v1', 'reader_example_key_0001');
  storage.setItem(`kordi.cloud.syncCursor.chat:${accountId}_other`, 'other account');
  storage.setItem('kordi.themeMode.v1', 'dark');
}

function accountKeys(storage: Storage, accountId: string) {
  return Object.keys(storage).filter(key => key.includes(accountId) && !key.includes(`${accountId}_other`));
}

test('account_deleted is told apart from other refusals and socket closes', () => {
  assert.equal(isAccountDeletedError(deleted()), true);
  assert.equal(isAccountDeletedError(new CloudAuthError('invalid_session', 'Expired.', 401)), false);
  assert.equal(isAccountDeletedError(new CloudAuthError('account_deleted', 'Gone.', 403)), false);
  assert.equal(isAccountDeletedClose({ code: 4410 }), true);
  assert.equal(isAccountDeletedClose({ code: 1006 }), false);
  assert.equal(isAccountDeletedClose(null), false);
  assert.equal(bearerCredential({ authorization: 'Bearer synthetic-token' }), 'synthetic-token');
  assert.equal(bearerCredential(new Headers({ Authorization: 'bearer  spaced ' })), 'spaced');
  assert.equal(bearerCredential({ 'content-type': 'application/json' }), null);
  assert.equal(bearerCredential(undefined), null);
});

test('only the deleted account\'s keys and the document reader key are erased', () => {
  const keys = [
    'kordi.cloud.syncCursor.chat:acct_gone',
    'kordi.organization.selected.acct_gone',
    'kordi.cloud.groupOutbox.v1:acct_gone',
    'kordi.commonGround.profile.v1:acct_gone',
    'kordi.documentReaderKey.v1',
    'kordi.cloud.syncCursor.chat:acct_gone_too',
    'kordi.cloud.syncCursor.chat:acct_kept',
    'kordi.themeMode.v1',
    'other.app:acct_gone',
  ];
  assert.deepEqual(accountLocalStorageKeys(keys, 'acct_gone'), [
    'kordi.cloud.groupOutbox.v1:acct_gone',
    'kordi.cloud.syncCursor.chat:acct_gone',
    'kordi.commonGround.profile.v1:acct_gone',
    'kordi.documentReaderKey.v1',
    'kordi.organization.selected.acct_gone',
  ]);
  assert.deepEqual(accountLocalStorageKeys(keys, ''), []);
  assert.deepEqual(accountLocalStorageKeys(keys, 'gone'), []);
});

test('a report names its account by id, by browser marker, or by the current session token', () => {
  const current = { token: 'synthetic-token', accountId: 'acct_current', expiresAt: '2099-01-01' };
  assert.equal(deletedAccountId({ accountId: 'acct_named' }, current), 'acct_named');
  assert.equal(deletedAccountId({ token: 'kordi-browser:acct_browser' }, null), 'acct_browser');
  assert.equal(deletedAccountId({ token: 'synthetic-token' }, current), 'acct_current');
  assert.equal(deletedAccountId({ token: 'older-token' }, current), undefined);
  assert.equal(deletedAccountId({}, current), 'acct_current');
  assert.equal(deletedAccountId({}, null), null);
});

function recordingTeardown(current: () => StoredSession | null) {
  const steps: string[] = [];
  const teardown: DeletedSessionTeardown = {
    current,
    erase: async (accountId) => { steps.push(`erase:${accountId}`); },
    eraseStorage: (accountId) => { steps.push(`storage:${accountId}`); },
    leaveWithoutReturn: () => { steps.push('leave'); },
    endSession: async () => { steps.push('end'); },
  };
  return { steps, teardown };
}

test('a deleted session ends once: data is erased first, then sign-in shows without a return path', async () => {
  const session = { token: 'synthetic-token', accountId: 'acct_once', expiresAt: '2099-01-01' };
  const { steps, teardown } = recordingTeardown(() => session);
  const results = await Promise.all([
    endDeletedCloudSession({ token: 'synthetic-token' }, teardown),
    endDeletedCloudSession({ accountId: 'acct_once' }, teardown),
  ]);
  assert.deepEqual(results, [true, true]);
  assert.deepEqual(steps, ['erase:acct_once', 'leave', 'end', 'storage:acct_once']);
  assert.equal(await endDeletedCloudSession({ token: 'older-token' }, teardown), false);
  assert.equal(steps.length, 4);
});

test('another account that signed in meanwhile keeps its session', async () => {
  let current: StoredSession | null = { token: 'synthetic-token', accountId: 'acct_switched', expiresAt: '2099-01-01' };
  const { steps, teardown } = recordingTeardown(() => current);
  teardown.erase = async (accountId) => {
    steps.push(`erase:${accountId}`);
    current = { token: 'new-token', accountId: 'acct_new', expiresAt: '2099-01-01' };
  };
  assert.equal(await endDeletedCloudSession({ token: 'synthetic-token' }, teardown), true);
  assert.deepEqual(steps, ['erase:acct_switched', 'leave', 'storage:acct_switched']);
});

test('a 401 account_deleted answer erases the account\'s data and signs out without a logout call', async () => {
  await withWindow(async ({ signedOut, storage, until }) => {
    const { state, backend } = memoryBackend({ token: 'synthetic-token', accountId: 'acct_request', expiresAt: '2099-01-01' });
    __setSessionBackendForTests(backend);
    seedStorage(storage, 'acct_request');
    await loadSession();
    const requests: string[] = [];
    const client = new CloudAuthClient({
      baseUrl: 'http://srv',
      fetchImpl: async (url) => {
        requests.push(String(url));
        return Response.json({ errorCode: 'account_deleted', message: 'This account was deleted.' }, { status: 401 });
      },
    });
    await assert.rejects(client.me('synthetic-token'), (error: unknown) => isAccountDeletedError(error));
    await until(() => signedOut() === 1, 'signed out');
    assert.equal(state.session, null);
    assert.equal(state.clears, 1);
    assert.deepEqual(requests, ['http://srv/v1/cloud/auth/me']);
    assert.deepEqual(accountKeys(storage, 'acct_request'), []);
    assert.equal(storage.getItem('kordi.documentReaderKey.v1'), null);
    assert.equal(storage.getItem('kordi.cloud.syncCursor.chat:acct_request_other'), 'other account');
    assert.equal(storage.getItem('kordi.themeMode.v1'), 'dark');

    // The profile check that saw it settles on the same teardown.
    endCloudSessionIfRejected('synthetic-token', deleted());
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(state.clears, 1);
  });
});

test('a plain invalid_session signs out and keeps local data', async () => {
  await withWindow(async ({ signedOut, storage, until }) => {
    const { state, backend } = memoryBackend({ token: 'synthetic-token', accountId: 'acct_expired', expiresAt: '2099-01-01' });
    __setSessionBackendForTests(backend);
    seedStorage(storage, 'acct_expired');
    endCloudSessionIfRejected('synthetic-token', new CloudAuthError('invalid_session', 'Session is expired or revoked.', 401));
    await until(() => signedOut() === 1, 'signed out');
    assert.equal(state.session, null);
    assert.equal(accountKeys(storage, 'acct_expired').length, 3);
    assert.equal(storage.getItem('kordi.documentReaderKey.v1'), 'reader_example_key_0001');
  });
});

test('a refused realtime ticket ends the session at once', async () => {
  const ticketClient = (status: number, body: unknown) => new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async () => Response.json(body, { status }),
  });
  await withWindow(async ({ signedOut, storage, until }) => {
    const { state, backend } = memoryBackend({ token: 'synthetic-token', accountId: 'acct_ticket', expiresAt: '2099-01-01' });
    __setSessionBackendForTests(backend);
    seedStorage(storage, 'acct_ticket');
    // A server error is transient and keeps the session.
    await assert.rejects(ticketClient(503, { errorCode: 'server_error' }).issueChatSyncRealtimeTicket('synthetic-token'));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(signedOut(), 0);
    // Any other 401 signs out and keeps local data.
    await assert.rejects(ticketClient(401, { errorCode: 'invalid_session' }).issueChatSyncRealtimeTicket('synthetic-token'));
    await until(() => signedOut() === 1, 'signed out');
    assert.equal(state.session, null);
    assert.equal(accountKeys(storage, 'acct_ticket').length, 3);
  });
  await withWindow(async ({ signedOut, storage, until }) => {
    const { state, backend } = memoryBackend({ token: 'synthetic-token', accountId: 'acct_ticket_gone', expiresAt: '2099-01-01' });
    __setSessionBackendForTests(backend);
    seedStorage(storage, 'acct_ticket_gone');
    await loadSession();
    await assert.rejects(ticketClient(401, { errorCode: 'account_deleted' }).issueChatSyncRealtimeTicket('synthetic-token'));
    await until(() => signedOut() >= 1, 'signed out');
    assert.equal(state.session, null);
    assert.deepEqual(accountKeys(storage, 'acct_ticket_gone'), []);
  });
});

test('a socket closed with 4410 ends the session and erases data; other closes do not', async () => {
  await withWindow(async ({ signedOut, storage, until }) => {
    const { state, backend } = memoryBackend({ token: 'synthetic-token', accountId: 'acct_socket', expiresAt: '2099-01-01' });
    __setSessionBackendForTests(backend);
    seedStorage(storage, 'acct_socket');
    await loadSession();
    assert.equal(endSessionIfAccountDeletedClose({ code: 1006 }, 'synthetic-token'), false);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(signedOut(), 0);
    assert.equal(endSessionIfAccountDeletedClose({ code: 4410 }, 'synthetic-token'), true);
    await until(() => signedOut() === 1, 'signed out');
    assert.equal(state.session, null);
    assert.deepEqual(accountKeys(storage, 'acct_socket'), []);
  });
});

test('a browser sign-in refresh refused for a deleted account erases its data', async () => {
  await withWindow(async ({ signedOut, storage, until }) => {
    const { state, backend } = memoryBackend(
      { token: 'old-token', accountId: 'acct_refresh', refreshToken: 'rt', expiresAt: '2000-01-01T00:00:00Z' },
      async () => { throw new Error('account_deleted'); },
    );
    __setSessionBackendForTests(backend);
    seedStorage(storage, 'acct_refresh');
    assert.equal(await loadSession(), null);
    await until(() => signedOut() === 1, 'signed out');
    assert.equal(state.session, null);
    assert.deepEqual(accountKeys(storage, 'acct_refresh'), []);
  });

  const reply = (body: unknown) => async () => Response.json(body, { status: 400 });
  const session = { token: 't', accountId: 'acct_x', refreshToken: 'rt', clientId: 'kordi-desktop', tokenEndpoint: 'http://srv/v1/cloud/auth/app/token', expiresAt: '2000-01-01' };
  await assert.rejects(refreshAppSession(session, reply({ error: 'invalid_grant', errorCode: 'account_deleted' })), /^Error: account_deleted$/);
  await assert.rejects(refreshAppSession(session, reply({ error: 'invalid_grant' })), /^Error: invalid_grant$/);
});

test('the Mac app marks the account folder for removal and stops its turns natively', async () => {
  const commands: Array<{ command: string; args: unknown }> = [];
  await withWindow(async ({ storage }) => {
    seedStorage(storage, 'acct_native');
    let outboxErased = '';
    await eraseCloudAccountLocalData('acct_native', {
      markNativeStorage: async (accountId) => { commands.push({ command: 'mark', args: accountId }); },
      eraseOutbox: async (accountId) => { outboxErased = accountId; },
      storage,
    });
    assert.deepEqual(commands, [{ command: 'mark', args: 'acct_native' }]);
    assert.equal(outboxErased, 'acct_native');
    assert.deepEqual(accountKeys(storage, 'acct_native'), []);
  });

  commands.length = 0;
  await withWindow(async () => {
    await eraseCloudAccountLocalData('acct_native_shell');
    assert.deepEqual(commands, [{ command: 'cloud_account_storage_mark_for_removal', args: { accountId: 'acct_native_shell' } }]);
  }, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown) => { commands.push({ command, args }); return null; },
    },
  });
});
