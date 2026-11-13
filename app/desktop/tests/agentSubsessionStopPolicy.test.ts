import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudAuthClient, CloudAuthError } from '../src/features/cloud/authClient';
import { __setSessionBackendForTests, clearSession, saveSession } from '../src/features/cloud/session';
import {
  classifySubsessionSyncFailure,
  publishModelSubsession,
  SUBSESSION_FINAL_PUBLISH_ATTEMPTS,
  SUBSESSION_SYNC_MAX_BACKOFF_MS,
  SUBSESSION_SYNC_STEP_MS,
  subscribeSubsessionSyncState,
  subsessionSyncDelayMs,
  subsessionSyncState,
} from '../src/features/cloud/agentSubsessionSync';
import type { CloudAgentSubsession, NativeAgentSubsession } from '../src/features/cloud/agentSubsessionTypes';

// Only an explicit Stop, a sign-out, an account change, or a follow-up that
// took the task over elsewhere stops a background session on this Mac. The
// cloud refusing updates marks it "not synced" and is retried with backoff.

type Command = { command: string; args: Record<string, unknown> };
type Harness = {
  commands: Command[];
  renewals: () => Command[];
  cancels: () => Command[];
  until: (condition: () => boolean, label: string) => Promise<void>;
  restore: () => void;
};

const signedIn = { token: 'synthetic', accountId: 'owner', expiresAt: '2099-01-01' };
const ownerBackend = { load: async () => signedIn, save: async () => {}, clear: async () => {} };

function harness({ snapshot, get, put }: {
  snapshot: () => Partial<NativeAgentSubsession>;
  get?: () => Promise<Partial<CloudAgentSubsession> | null>;
  put: (value: NativeAgentSubsession) => Promise<Partial<CloudAgentSubsession>>;
}): Harness {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldGet = CloudAuthClient.prototype.getAgentSubsession;
  const oldPut = CloudAuthClient.prototype.putAgentSubsession;
  const oldInfo = console.info;
  const oldWarn = console.warn;
  console.info = () => undefined;
  console.warn = () => undefined;
  const commands: Command[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout: (callback: () => void) => setTimeout(callback, 1),
    dispatchEvent: () => true,
    __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown>) => {
      commands.push({ command, args });
      if (command === 'desktop_chat_subsession_snapshot') {
        return { sessionId: 'child', parentSessionId: 'parent', parentRequestId: 'request', turnId: 'turn',
          title: 'Review', status: 'running', messages: [], ...snapshot() };
      }
      if (command === 'desktop_chat_renew_execution_lease' || command === 'desktop_chat_cancel_turn') return null;
      throw Error(`Unexpected command: ${command}`);
    } },
  } });
  __setSessionBackendForTests(ownerBackend);
  CloudAuthClient.prototype.getAgentSubsession = async () => ((await (get ?? (async () => ({ status: 'running', version: 1 })))()) ?? (() => { throw new CloudAuthError('unknown', 'Not found', 404); })()) as CloudAgentSubsession;
  CloudAuthClient.prototype.putAgentSubsession = async (_token, value) => (await put(value)) as CloudAgentSubsession;
  return {
    commands,
    renewals: () => commands.filter(entry => entry.command === 'desktop_chat_renew_execution_lease'),
    cancels: () => commands.filter(entry => entry.command === 'desktop_chat_cancel_turn'),
    until: async (condition, label) => {
      for (let wait = 0; wait < 2000 && !condition(); wait += 1) await new Promise(resolve => setTimeout(resolve, 1));
      assert(condition(), label);
    },
    restore: () => {
      CloudAuthClient.prototype.getAgentSubsession = oldGet;
      CloudAuthClient.prototype.putAgentSubsession = oldPut;
      __setSessionBackendForTests(null);
      console.info = oldInfo;
      console.warn = oldWarn;
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    },
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test('answers that refuse an update are retried with backoff; no answer is retried at once', () => {
  assert.deepEqual(classifySubsessionSyncFailure(new Error('database is locked')), { kind: 'unanswered' });
  assert.deepEqual(classifySubsessionSyncFailure(new CloudAuthError('server_error', 'Down', 503)), { kind: 'unanswered' });
  assert.deepEqual(classifySubsessionSyncFailure(new CloudAuthError('rate_limited', 'Slow down', 429)), { kind: 'unanswered' });
  assert.deepEqual(classifySubsessionSyncFailure(new CloudAuthError('unknown', 'Conflict', 409, undefined, { serverCode: 'subsession_version_conflict' })),
    { kind: 'refused', refusal: { status: 409, code: 'subsession_version_conflict' } });
  assert.deepEqual(classifySubsessionSyncFailure(new CloudAuthError('unauthorized', 'Sign in again', 401)),
    { kind: 'refused', refusal: { status: 401, code: 'unauthorized' } });
  assert.equal(subsessionSyncDelayMs(0), SUBSESSION_SYNC_STEP_MS);
  assert.equal(subsessionSyncDelayMs(1), SUBSESSION_SYNC_STEP_MS);
  assert.equal(subsessionSyncDelayMs(2), SUBSESSION_SYNC_STEP_MS * 2);
  assert.equal(subsessionSyncDelayMs(3), SUBSESSION_SYNC_STEP_MS * 4);
  assert.equal(subsessionSyncDelayMs(50), SUBSESSION_SYNC_MAX_BACKOFF_MS);
});

test('version conflicts and an expired sign-in keep the task running and show it as not synced', async () => {
  let writes = 0;
  let reads = 0;
  let finished = false;
  const states: boolean[] = [];
  const unsubscribe = subscribeSubsessionSyncState(() => states.push(subsessionSyncState('child').synced));
  const h = harness({
    snapshot: () => ({ status: finished ? 'done' : 'running' }),
    get: async () => { reads += 1; return { status: 'running', version: 10 + reads }; },
    put: async (value) => {
      writes += 1;
      if (writes >= 2 && writes <= 6) throw new CloudAuthError('unknown', 'Conflict', 409, undefined, { serverCode: 'subsession_version_conflict' });
      if (writes >= 7 && writes <= 9) throw new CloudAuthError('unauthorized', 'Sign in again', 401);
      if (writes >= 10) finished = true;
      return { status: value.status, version: 100 + writes };
    },
  });
  try {
    await publishModelSubsession('child');
    await h.until(() => writes >= 4, 'the loop retried the refused update');
    assert.equal(subsessionSyncState('child').synced, false);
    assert.deepEqual(subsessionSyncState('child').refusal, { status: 409, code: 'subsession_version_conflict' });
    const duringConflicts = h.renewals().length;
    await h.until(() => writes >= 8, 'the loop reached the expired sign-in');
    assert(h.renewals().length > duringConflicts, 'refused updates keep renewing the lease');
    assert(h.renewals().some(entry => (entry.args.refusal as { code?: string } | null)?.code === 'subsession_version_conflict'),
      'renewals carry the last refusal, so a lapse can name it');
    assert(h.renewals().some(entry => (entry.args.refusal as { status?: number } | null)?.status === 401));
    assert(reads >= 6, 'each refusal reloads the version');
    await h.until(() => writes >= 11, 'the loop published the finished task');
    await settle();
    assert.equal(h.cancels().length, 0, 'a refusing cloud never stops the task');
    assert.equal(subsessionSyncState('child').synced, true, 'an accepted update clears the refusal');
    assert(states.includes(false) && states.at(-1) === true);
    assert.equal(h.renewals().at(-1)?.args.refusal, null, 'renewals after recovery name no refusal');
  } finally {
    unsubscribe();
    await settle();
    h.restore();
  }
});

test('an empty sign-in read once is not a sign-out; a lasting one stops the task as signed out', async () => {
  let writes = 0;
  let emptyReads = 0;
  // One read finds no stored sign-in (a save in progress), the next finds it again.
  const emptyOnce = { ...ownerBackend, load: async () => {
    emptyReads += 1;
    queueMicrotask(() => __setSessionBackendForTests(ownerBackend));
    return null;
  } };
  const h = harness({
    snapshot: () => ({}),
    put: async (value) => {
      writes += 1;
      if (writes === 2) __setSessionBackendForTests(emptyOnce);
      if (writes === 4) void clearSession();
      return { status: value.status, version: writes };
    },
  });
  try {
    await publishModelSubsession('child');
    await h.until(() => h.cancels().length === 1, 'a lasting sign-out stops the task');
    assert.equal(emptyReads, 1, 'the loop met one empty read');
    assert(writes >= 4, 'the loop kept publishing through one empty read');
    assert.deepEqual(h.cancels()[0].args, { turnId: 'turn', reason: { kind: 'signed_out' } });
    await settle();
    assert.equal(h.cancels().length, 1);
  } finally {
    await settle();
    h.restore();
  }
});

test('an account change stops the task and says so', async () => {
  let writes = 0;
  const h = harness({
    snapshot: () => ({}),
    put: async (value) => {
      if (++writes === 3) void saveSession({ ...signedIn, accountId: 'someone-else' });
      return { status: value.status, version: writes };
    },
  });
  try {
    await publishModelSubsession('child');
    await h.until(() => h.cancels().length === 1, 'the account change stopped the task');
    assert.deepEqual(h.cancels()[0].args, { turnId: 'turn', reason: { kind: 'account_changed' } });
  } finally {
    await settle();
    h.restore();
  }
});

test('a follow-up that started elsewhere stops this Mac\'s run, so two runtimes never run one task', async () => {
  let writes = 0;
  const h = harness({
    snapshot: () => ({}),
    put: async (value) => ({ status: value.status, version: ++writes, hasFollowupExecution: writes >= 3 }),
  });
  try {
    await publishModelSubsession('child');
    await h.until(() => h.cancels().length === 1, 'the takeover stopped the local run');
    assert.deepEqual(h.cancels()[0].args, { turnId: 'turn', reason: { kind: 'continued_elsewhere' } });
    const renewalsAtStop = h.renewals().length;
    await settle();
    assert.equal(h.renewals().length, renewalsAtStop, 'a stopped task no longer renews its lease');
  } finally {
    await settle();
    h.restore();
  }
});

test('a Stop from another device stops the task with the reason the cloud recorded', async () => {
  let writes = 0;
  const h = harness({
    snapshot: () => ({}),
    put: async (value) => {
      writes += 1;
      return writes >= 2 ? { status: 'stopped', version: writes, stopReason: { kind: 'user', accountId: 'owner' } } : { status: value.status, version: writes };
    },
  });
  try {
    await publishModelSubsession('child');
    await h.until(() => h.cancels().length === 1, 'the remote Stop reached this Mac');
    assert.deepEqual(h.cancels()[0].args, { turnId: 'turn', reason: { kind: 'user', accountId: 'owner' } });
  } finally {
    await settle();
    h.restore();
  }
});

test('a stopped task publishes why it stopped', async () => {
  const published: NativeAgentSubsession[] = [];
  const h = harness({
    snapshot: () => ({ status: 'stopped', turnId: 'turn', stopReason: { kind: 'lease_lapsed', status: 409, code: 'subsession_version_conflict' } }),
    put: async (value) => { published.push(value); return { status: value.status, version: 2 }; },
  });
  try {
    await publishModelSubsession('child');
    await settle();
    assert.equal(published.length, 1);
    assert.deepEqual(published[0].stopReason, { kind: 'lease_lapsed', status: 409, code: 'subsession_version_conflict' });
    assert.equal(h.renewals().length, 0, 'a finished task needs no lease');
  } finally {
    h.restore();
  }
});

test('a finished task stops retrying a final update the cloud keeps refusing', async () => {
  let writes = 0;
  const h = harness({
    snapshot: () => ({ status: 'done' }),
    put: async () => { writes += 1; throw new CloudAuthError('invalid_request', 'Rejected', 400); },
  });
  try {
    await publishModelSubsession('child');
    await h.until(() => writes >= SUBSESSION_FINAL_PUBLISH_ATTEMPTS, 'the loop retried the final update');
    await settle();
    assert.equal(writes, SUBSESSION_FINAL_PUBLISH_ATTEMPTS);
    assert.equal(h.cancels().length, 0);
  } finally {
    h.restore();
  }
});
