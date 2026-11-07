import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyCloudGroupAgentControl } from '../src/features/cloud/cloudGroupAgentControl';
import type { ApplyCloudGroupAgentControlInput } from '../src/features/cloud/cloudGroupAgentControl.types';
import type { CloudAgentTurnCoordinator } from '../src/features/cloud/cloudAgentTurnCoordinator';
import type { CloudGroupAgentRuntime } from '../src/features/cloud/cloudGroupControlContext';
import { CloudGroupDeferredMentions } from '../src/features/cloud/cloudGroupDeferredMentions';

const OWNER = 'acct_owner';
const GROUP = 'session:group:new-group';

type CloudAgentTurnJob = Parameters<CloudAgentTurnCoordinator['enqueue']>[0];

/** An @mention of the owner's agent in a group created just now. */
function mentionInput(runtime: CloudGroupAgentRuntime): ApplyCloudGroupAgentControlInput {
  const participants = [
    { accountId: OWNER, displayName: 'Owner', role: 'admin' },
    { accountId: 'acct_peer', displayName: 'Peer', role: 'person' },
  ];
  return {
    context: {
      account: { accountId: OWNER },
      cloudMessage: { messageId: 'wire-1', createdAt: new Date().toISOString(), sessionId: GROUP },
      envelope: {
        kind: 'group-message',
        groupId: GROUP,
        createdByAccountId: OWNER,
        actor: participants[0],
        participants,
        message: {
          id: 'mention-1',
          senderAccountId: OWNER,
          senderKind: 'human',
          text: '@Kordi reply once',
          createdAtMs: Date.now(),
          targetCloudAgentId: `cloud-agent:${OWNER}`,
          targetCloudAgentOwnerAccountId: OWNER,
        },
      },
    },
    setCanonicalState: () => {},
    runtime,
    stateOps: {},
    policy: {
      isRecentMention: () => true,
      messageTargetsLocalAgent: () => true,
      responseExists: () => false,
    },
  } as unknown as ApplyCloudGroupAgentControlInput;
}

function runtimeFixture(deferred: CloudGroupDeferredMentions) {
  const jobs: CloudAgentTurnJob[] = [];
  const processedMentionIds = new Set<string>();
  const runtime = (ready: boolean): CloudGroupAgentRuntime => ({
    ready,
    deferMention: (requestId, retry) => deferred.defer(requestId, retry),
    turnCoordinator: {
      enqueue: (job: CloudAgentTurnJob) => {
        jobs.push(job);
        return { accepted: true, queued: false };
      },
    },
    messageIndex: () => ({ groupRows: [] }),
    processedMentionIds,
  } as unknown as CloudGroupAgentRuntime);
  return { jobs, processedMentionIds, runtime };
}

test('a mention skipped while the runtime reloads is claimed once it is ready again', () => {
  const deferred = new CloudGroupDeferredMentions();
  const { jobs, processedMentionIds, runtime } = runtimeFixture(deferred);

  applyCloudGroupAgentControl(mentionInput(runtime(false)));
  assert.equal(jobs.length, 0, 'a reloading runtime does not claim');
  assert.equal(processedMentionIds.has('mention-1'), false);

  // Still reloading: the mention stays kept.
  deferred.applyAll(runtime(false));
  assert.equal(jobs.length, 0);

  deferred.applyAll(runtime(true));
  assert.equal(jobs.length, 1, 'the ready runtime claims the kept mention');
  assert.equal(jobs[0].requestId, 'mention-1');
  assert.equal(processedMentionIds.has('mention-1'), true);

  // Neither another readiness change nor the same mention arriving again
  // starts a second claim.
  deferred.applyAll(runtime(true));
  applyCloudGroupAgentControl(mentionInput(runtime(true)));
  assert.equal(jobs.length, 1);
});

test('a mention that arrives twice while not ready is kept once', () => {
  const deferred = new CloudGroupDeferredMentions();
  const { jobs, runtime } = runtimeFixture(deferred);
  applyCloudGroupAgentControl(mentionInput(runtime(false)));
  applyCloudGroupAgentControl(mentionInput(runtime(false)));
  deferred.applyAll(runtime(true));
  assert.equal(jobs.length, 1);
});

test('kept mentions of a previous account are dropped', () => {
  const deferred = new CloudGroupDeferredMentions();
  const { jobs, runtime } = runtimeFixture(deferred);
  applyCloudGroupAgentControl(mentionInput(runtime(false)));
  deferred.clear();
  deferred.applyAll(runtime(true));
  assert.equal(jobs.length, 0);
});
