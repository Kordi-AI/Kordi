import assert from 'node:assert/strict';
import test from 'node:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';

import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionCatalog,
  CanonicalSessionMessage,
  CanonicalSessionState,
  UpsertCanonicalIdentityRequest,
} from '../src/kordi-app/types';
import {
  canonicalStateFromStore,
  createCanonicalStore,
  mergeCanonicalCatalog,
} from '../src/features/canonical/canonicalStore';
import { isTerminalCloudAgentTurn } from '../src/features/canonical/cloudAgentTurnLifecycle';
import { buildCanonicalIndexes } from '../src/features/canonical/readModel/indexes';
import { applyCloudGroupMessageControl } from '../src/features/cloud/cloudGroupMessageControl';
import type { CloudGroupControlEnvelope } from '../src/features/cloud/cloudGroupMessages';
import {
  isCloudAgentProcessingPlaceholderText,
  removeCanonicalMessageById,
  removeCloudGroupOfflinePlaceholder,
  removeCloudGroupPendingRowsForTerminalResponse,
  removeCloudGroupTimeoutPlaceholderForTerminalResponse,
} from '../src/features/cloud/cloudAgentRequestState';
import { upsertCanonicalIdentityIntoLocalState } from '../src/features/cloud/cloudCanonicalStateMerge';
import {
  cloudGroupAgentProcessingSlotForResponse,
  cloudGroupIncomingMessageAlreadyApplied,
} from '../src/features/cloud/useCloudGroupControlApplication';
import { cleanCloudText, cloudObjectContent } from '../src/features/cloud/cloudValue';
import type { CloudGroupControlContext } from '../src/features/cloud/cloudGroupControlContext';

const GROUP = 'session:group:reply-slot';
const OWNER = 'acct_owner';
const PEER = 'acct_peer';
const REQUEST_ID = 'msg:ui:request';
const SLOT_ID = `msg:cloud-agent-processing:${REQUEST_ID}:${OWNER}`;

const stateOps = {
  objectContent: cloudObjectContent,
  cleanText: cleanCloudText,
  upsertIdentity: upsertCanonicalIdentityIntoLocalState,
  processingSlot: cloudGroupAgentProcessingSlotForResponse,
  incomingAlreadyApplied: cloudGroupIncomingMessageAlreadyApplied,
  removeOfflinePlaceholder: removeCloudGroupOfflinePlaceholder,
  removeTimeoutPlaceholder: removeCloudGroupTimeoutPlaceholderForTerminalResponse,
  removePendingRows: removeCloudGroupPendingRowsForTerminalResponse,
  removeMessage: removeCanonicalMessageById,
  isProcessingPlaceholder: isCloudAgentProcessingPlaceholderText,
};

type GroupMessage = NonNullable<CloudGroupControlEnvelope['message']>;

const request: GroupMessage = {
  id: REQUEST_ID, senderAccountId: PEER, senderKind: 'person', senderDisplayName: 'Peer',
  text: '@Kordi share the progress', createdAtMs: 1_000,
};
const waiting: GroupMessage = {
  id: SLOT_ID, senderAccountId: OWNER, senderAgentId: 'kordi', senderKind: 'agent',
  senderDisplayName: 'Kordi', text: '', deliveryState: 'processing', createdAtMs: 2_000,
  replyToMessageId: REQUEST_ID, requestId: REQUEST_ID,
};
const unrelated: GroupMessage = {
  id: 'msg:ui:unrelated', senderAccountId: PEER, senderKind: 'person', senderDisplayName: 'Peer',
  text: 'Meanwhile, another question', createdAtMs: 3_000,
};
const reply: GroupMessage = {
  ...waiting, id: 'msg:cloud-agent:turn-one', text: 'Here is the progress.',
  deliveryState: 'complete', createdAtMs: 4_000,
};

// Conversation sequences on the server: request 17, waiting 18, unrelated 19, reply 20.
const SEQUENCE: Record<string, number> = {
  [request.id]: 17, [waiting.id]: 18, [unrelated.id]: 19, [reply.id]: 20,
};

function emptyState(): CanonicalSessionState {
  const catalog: CanonicalSessionCatalog = {
    storagePath: '/tmp/canonical-fixture.sqlite',
    profile: {
      id: 'fixture', humanIdentityId: `human:${PEER}`, storageRoot: '/tmp',
      createdAtMs: 1, updatedAtMs: 1,
    },
    identities: [], participants: [], delegatedExchanges: [], presence: [],
    sessions: [{
      id: GROUP, kind: 'group', title: 'Group', status: 'active', createdByIdentityId: `human:${OWNER}`,
      createdAtMs: 1, updatedAtMs: 1,
    }],
    summaries: [],
  };
  return { ...canonicalStateFromStore(mergeCanonicalCatalog(createCanonicalStore(), catalog))!, messages: [] };
}

function context(state: CanonicalSessionState, message: GroupMessage): CloudGroupControlContext {
  const participant = (accountId: string) => ({
    accountId, displayName: accountId, avatarUrl: null, role: 'person' as const,
  });
  return {
    account: { accountId: PEER } as CloudGroupControlContext['account'],
    cloudMessage: {
      messageId: `wire-${SEQUENCE[message.id]}`, fromAccountId: message.senderAccountId, toAccountId: PEER,
      body: '', createdAt: new Date(message.createdAtMs).toISOString(), deliveredAt: null, readAt: null,
      direction: message.senderAccountId === PEER ? 'outgoing' : 'incoming',
      sessionId: GROUP, version: 1, conversationSequence: SEQUENCE[message.id],
    },
    envelope: {
      kind: 'group-message', groupId: GROUP, groupTitle: 'Group', createdByAccountId: OWNER,
      actor: participant(message.senderAccountId), participants: [participant(OWNER), participant(PEER)], message,
    },
    canonicalState: state, nextState: state, localHumanIdentityId: `human:${PEER}`,
    groupSpaceId: GROUP,
    participantByAccount: new Map([[OWNER, participant(OWNER)], [PEER, participant(PEER)]]),
    identityIdByAccount: new Map([[OWNER, `human:${OWNER}`], [PEER, `human:${PEER}`]]),
  };
}

/** Emulates canonical persistence: one stable slot row, terminal rows never reopen. */
async function withCanonicalStore<T>(run: (upserts: AppendCanonicalMessageRequest[]) => Promise<T>): Promise<T> {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  const rows = new Map<string, CanonicalSessionMessage>();
  const upserts: AppendCanonicalMessageRequest[] = [];
  mockIPC((command, payload) => {
    if (command === 'desktop_canonical_upsert_identity_fast') {
      const identity = payload?.request as UpsertCanonicalIdentityRequest;
      return { ...identity, createdAtMs: 1, updatedAtMs: 1 };
    }
    assert.equal(command, 'desktop_canonical_upsert_message_fast');
    const incoming = payload?.request as AppendCanonicalMessageRequest;
    upserts.push(incoming);
    const id = incoming.id!;
    const sequenceNum = Number(incoming.sourceEventId?.split('wire-')[1]);
    const existing = rows.get(id);
    const candidate: CanonicalSessionMessage = {
      ...incoming, id, content: incoming.content ?? null, status: incoming.status ?? 'sent',
      parentMessageId: incoming.parentMessageId ?? null, createdAtMs: incoming.createdAtMs!,
      sequenceNum, updatedAtMs: upserts.length, contentHash: null,
    };
    if (existing && isTerminalCloudAgentTurn(existing) && !isTerminalCloudAgentTurn(candidate)) {
      const adopted = candidate.createdAtMs < existing.createdAtMs
        ? { ...existing, createdAtMs: candidate.createdAtMs, sequenceNum: Math.min(existing.sequenceNum, sequenceNum) }
        : existing;
      rows.set(id, adopted);
      return adopted;
    }
    const next = existing && existing.messageKind === 'agent-turn'
      ? { ...candidate, createdAtMs: existing.createdAtMs, sequenceNum: existing.sequenceNum }
      : candidate;
    rows.set(id, next);
    return next;
  });
  try {
    return await run(upserts);
  } finally {
    clearMocks();
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

async function applyAll(messages: GroupMessage[]) {
  let state: CanonicalSessionState | null = emptyState();
  for (const message of messages) {
    await applyCloudGroupMessageControl({
      context: context(state!, message),
      setCanonicalState: (update) => { state = update(state); },
      stateOps,
    });
  }
  return state!;
}

function renderedIds(state: CanonicalSessionState) {
  return (buildCanonicalIndexes(state).canonicalMessagesBySessionId.get(GROUP) ?? [])
    .map((message) => message.id);
}

const liveOrder = [REQUEST_ID, SLOT_ID, unrelated.id];

test('a reply that replaces its waiting row stays directly under the request', async () => {
  await withCanonicalStore(async () => {
    const live = await applyAll([request, waiting, unrelated, reply]);
    assert.deepEqual(renderedIds(live), liveOrder);
  });
});

test('history that replays the reply before its waiting row renders the live order', async () => {
  const live = await withCanonicalStore(() => applyAll([request, waiting, unrelated, reply]));
  const liveSlot = live.messages.find((message) => message.id === SLOT_ID)!;
  for (const replayOrder of [
    [reply, unrelated, request, waiting],
    [request, unrelated, reply, waiting],
  ]) {
    // Each replay starts from an empty local store, as on a fresh install.
    const restored = await withCanonicalStore(() => applyAll(replayOrder));
    assert.deepEqual(renderedIds(restored), liveOrder);
    const slot = restored.messages.find((message) => message.id === SLOT_ID)!;
    assert.equal(slot.contentText, reply.text);
    assert.equal(slot.status, 'received');
    assert.deepEqual([slot.createdAtMs, slot.sequenceNum], [liveSlot.createdAtMs, liveSlot.sequenceNum]);
  }
});

test('a reply without a waiting row keeps its own place', async () => {
  await withCanonicalStore(async (upserts) => {
    const state = await applyAll([request, unrelated, reply]);
    assert.deepEqual(renderedIds(state), [REQUEST_ID, unrelated.id, SLOT_ID]);
    // A later pending replay neither reopens nor moves the reply.
    const before = upserts.length;
    let replayed: CanonicalSessionState | null = state;
    const result = await applyCloudGroupMessageControl({
      context: context(state, { ...waiting, createdAtMs: 5_000 }),
      setCanonicalState: (update) => { replayed = update(replayed); },
      stateOps,
    });
    assert.equal(result, null);
    assert.equal(upserts.length, before);
    assert.deepEqual(renderedIds(replayed!), [REQUEST_ID, unrelated.id, SLOT_ID]);
  });
});
