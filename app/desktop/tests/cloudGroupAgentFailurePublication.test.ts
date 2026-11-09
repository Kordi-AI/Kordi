import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { CloudMessage, SendCloudMessageOptions } from '../src/features/cloud/authClient';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import {
  __resetPublishedCloudGroupAgentFailuresForTests,
  handleCloudGroupAgentFailure,
  type HandleCloudGroupAgentFailureInput,
} from '../src/features/cloud/cloudGroupAgentFailure';
import { publishCloudGroupAgentProcessingBestEffort } from '../src/features/cloud/cloudGroupAgentPublication';
import { parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import type {
  CloudGroupAgentRuntime,
  CloudGroupMessageControlContext,
} from '../src/features/cloud/cloudGroupControlContext';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

type Send = { peer: string; body: string; options: SendCloudMessageOptions };

const timedOut = () => new CloudAuthError(
  'network_error',
  'Cloud request timed out. Check your connection and try again.',
  0,
);

const owner = { accountId: 'acct_owner', displayName: 'Owner', role: 'admin' };
const alex = { accountId: 'acct_alex', displayName: 'Alex', role: 'member' };
const priya = { accountId: 'acct_priya', displayName: 'Priya', role: 'member' };

function groupContext(): CloudGroupMessageControlContext {
  return {
    account: { accountId: owner.accountId, displayName: 'Owner', primaryEmail: 'owner@example.com', avatar: cloudAccountAvatarFixture },
    cloudMessage: { fromAccountId: alex.accountId, toAccountId: owner.accountId, createdAt: new Date().toISOString() },
    envelope: {
      kind: 'group-message', groupId: 'group-1', groupSpaceId: 'space-1', groupTitle: 'Team',
      createdByAccountId: owner.accountId, actor: alex, participants: [owner, alex, priya],
      message: {
        id: 'request-1', senderAccountId: alex.accountId, text: '@babyshu hi', createdAtMs: 1,
        targetCloudAgentName: 'babyshu', messageAction: null,
      },
    },
    groupSpaceId: 'space-1',
    participantByAccount: new Map([[owner.accountId, owner], [alex.accountId, alex], [priya.accountId, priya]]),
  } as unknown as CloudGroupMessageControlContext;
}

function recordingSender(fail?: (peer: string) => Error | null) {
  const sends: Send[] = [];
  return {
    sends,
    sender: {
      async sendMessage(_token: string, peer: string, body: string, options: SendCloudMessageOptions = {}) {
        sends.push({ peer, body, options });
        const error = fail?.(peer);
        if (error) throw error;
        return { messageId: `server:${sends.length}`, body } as unknown as CloudMessage;
      },
    },
  };
}

function failureInput(client: ReturnType<typeof recordingSender>['sender'], reported: unknown[]) {
  const runtime = {
    client,
    turnIdsByRequestId: new Map<string, string>(),
    reportFailure: (_kind: string, error: unknown) => { reported.push(error); },
    mergeMessage: () => undefined,
    syncDiff: async () => undefined,
  } as unknown as CloudGroupAgentRuntime;
  return {
    context: groupContext(),
    setCanonicalState: () => undefined,
    runtime,
    stateOps: {
      cleanText: (value?: string | null) => value?.trim() ?? '',
      removePendingRows: (current) => current,
      removeTimeoutPlaceholder: (current) => current,
    },
  } satisfies HandleCloudGroupAgentFailureInput;
}

async function until(condition: () => boolean) {
  for (let tick = 0; tick < 200 && !condition(); tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(condition(), 'condition was not met in time');
}

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const upserts: string[] = [];

beforeEach(() => {
  __resetPublishedCloudGroupAgentFailuresForTests();
  upserts.length = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (command: string, args: { request: { id: string } }) => {
      if (command !== 'desktop_canonical_upsert_message_fast') throw Error(`Unexpected command: ${command}`);
      upserts.push(args.request.id);
      return args.request;
    } },
  } });
  __setSessionBackendForTests({
    load: async () => ({ token: 'synthetic', accountId: owner.accountId, expiresAt: '2099-01-01' }),
    save: async () => {},
    clear: async () => {},
  });
});

afterEach(() => {
  __setSessionBackendForTests(null);
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

test('one mention gets at most one failure reply from this Mac', async () => {
  const { sends, sender } = recordingSender();
  const reported: unknown[] = [];
  const input = failureInput(sender, reported);

  await handleCloudGroupAgentFailure(timedOut(), input);
  await until(() => sends.length === 2);
  // A second failure path for the same mention, as the coordinator's onError.
  await handleCloudGroupAgentFailure(new Error('UNIQUE constraint failed'), input);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(sends.length, 2, 'one send per member, once');
  assert.deepEqual(upserts, ['msg:cloud-agent-processing:request-1:acct_owner']);
  assert.equal(reported.length, 2, 'the second error is still reported');
  const failure = parseCloudGroupControl(sends[0]!.body)?.message;
  assert.equal(failure?.deliveryState, 'failed');
  assert.equal(failure?.text, "babyshu couldn't reply.");
  // Every copy carries one stable id, so a resend is a no-op in the outbox and on the server.
  assert.ok(sends[0]!.options.clientMessageId);
  assert.equal(sends[1]!.options.clientMessageId, sends[0]!.options.clientMessageId);
});

test('a failure for a held run is published through the lease, ending the run', async () => {
  const chat = recordingSender();
  const lease = recordingSender();
  const reported: unknown[] = [];

  await handleCloudGroupAgentFailure(new Error('Turn failed'), {
    ...failureInput(chat.sender, reported),
    publisher: lease.sender,
  });
  await until(() => lease.sends.length === 2);

  assert.equal(chat.sends.length, 0, 'never posted as a plain chat message');
  assert.equal(parseCloudGroupControl(lease.sends[0]!.body)?.message?.deliveryState, 'failed');
});

test('a failure reaching one member is not reported as a failed fanout', async () => {
  const { sends, sender } = recordingSender((peer) => (peer === priya.accountId ? timedOut() : null));
  const reported: unknown[] = [];

  await handleCloudGroupAgentFailure(new Error('Turn failed'), failureInput(sender, reported));
  await until(() => sends.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Only the original error: one delivered copy reaches the whole group.
  assert.equal(reported.length, 1);
});

test('a processing placeholder that fails to publish never throws', async () => {
  const { sends, sender } = recordingSender(() => timedOut());
  const reported: unknown[] = [];
  const runtime = {
    client: sender,
    mergeMessage: () => undefined,
  } as unknown as CloudGroupAgentRuntime;

  await publishCloudGroupAgentProcessingBestEffort({
    publisher: sender,
    runtime,
    token: 'synthetic',
    targetAccountIds: [alex.accountId, priya.accountId],
    body: 'kordi-cloud-group:e30',
    sessionId: 'group-1',
    createdAtMs: 1,
  }, (error) => reported.push(error));

  assert.equal(sends.length, 2);
  assert.equal(reported.length, 1);
  assert.match(String((reported[0] as Error).message), /timed out/);

  // A publisher that throws before sending is reported the same way.
  const broken = { async sendMessage(): Promise<CloudMessage> { throw new Error('boom'); } };
  await publishCloudGroupAgentProcessingBestEffort({
    publisher: broken, runtime, token: 'synthetic', targetAccountIds: [alex.accountId],
    body: 'kordi-cloud-group:e30', sessionId: 'group-1', createdAtMs: 1,
  }, (error) => reported.push(error));
  assert.equal(reported.length, 2);
});
