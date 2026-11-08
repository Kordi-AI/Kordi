import { upsertCanonicalMessageFast } from '@/lib/desktop';
import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionState,
  MessageActionMetadata,
} from '@/kordi-app/types';
import { mergeCanonicalMessageRow } from '@/features/canonical/canonicalStateReducers';
import {
  beginChatPerformanceSpan,
  finishChatPerformanceSpan,
} from '@/features/performance/chatPerformance';
import {
  cloudAgentNoProviderNoticeText,
  isCloudAgentNoProviderConfiguredError,
} from './cloudAgentMessages';
import {
  cloudGroupAgentConversationId,
  cloudGroupAgentResponseTargetAccountIds,
  cloudGroupSelfParticipant,
  encodeCloudGroupControl,
} from './cloudGroupMessages';
import { loadSession } from './session';
import { isAgentUnavailableRefusal } from './agentRestrictions';
import { cloudAgentLocalFailureMessage } from './cloudAgentLocalExecution';
import { cloudAgentSharedFailure } from './cloudAgentFailureNotices';
import type { CloudAgentFailureCode } from './cloudAgentFailureCode';
import {
  cloudAgentCanonicalIdentityId,
  cloudAgentDisplayName,
  cloudAgentId,
} from './cloudAgentIdentity';
import type {
  CanonicalSessionStateSetter,
  CloudGroupAgentRuntime,
  CloudGroupMessageControlContext,
} from './cloudGroupControlContext';
import type { CloudAuthClient } from './authClient';
import { publishCloudGroupAgentEnvelope } from './cloudGroupAgentPublication';

type CloudGroupAgentFailureStateOps = {
  cleanText(value?: string | null): string;
  removePendingRows(
    current: CanonicalSessionState | null,
    requestId: string,
    targetAccountId: string,
  ): CanonicalSessionState | null;
  removeTimeoutPlaceholder(
    current: CanonicalSessionState | null,
    noticeId: string,
  ): CanonicalSessionState | null;
};

export type HandleCloudGroupAgentFailureInput = {
  context: CloudGroupMessageControlContext;
  setCanonicalState: CanonicalSessionStateSetter;
  runtime: CloudGroupAgentRuntime;
  stateOps: CloudGroupAgentFailureStateOps;
  signal?: AbortSignal;
  /**
   * The execution lease's publisher when this Mac holds the run. The failure
   * then ends the run on the server, so the cloud never answers it again.
   */
  publisher?: Pick<CloudAuthClient, 'sendMessage'>;
};

// Requests whose failure this Mac already published, so a second failure
// path for the same mention posts nothing.
const publishedFailureKeys = new Set<string>();
const PUBLISHED_FAILURE_KEY_LIMIT = 500;

function cloudGroupAgentFailureKey(accountId: string, requestId: string): string {
  return `${accountId}:${requestId}`;
}

function rememberPublishedFailure(key: string): void {
  publishedFailureKeys.add(key);
  if (publishedFailureKeys.size > PUBLISHED_FAILURE_KEY_LIMIT) {
    const oldest = publishedFailureKeys.values().next().value;
    if (oldest !== undefined) publishedFailureKeys.delete(oldest);
  }
}

/** Test hook: forgets which failures were published. */
export function __resetPublishedCloudGroupAgentFailuresForTests(): void {
  publishedFailureKeys.clear();
}

export function cloudGroupAgentFailureNoticeRequest({
  accountId,
  agentId,
  groupId,
  requestId,
  agentDisplayName,
  ownerDisplayName,
  error,
  messageAction = null,
  now = Date.now(),
}: {
  accountId: string;
  agentId?: string | null;
  groupId: string;
  requestId: string;
  agentDisplayName: string;
  ownerDisplayName?: string | null;
  error: unknown;
  messageAction?: MessageActionMetadata | null;
  now?: number;
}): AppendCanonicalMessageRequest {
  const noProvider = isCloudAgentNoProviderConfiguredError(error);
  const failureText = noProvider
    ? cloudAgentNoProviderNoticeText()
    : cloudAgentLocalFailureMessage(error);
  const processingMessageId =
    `msg:cloud-agent-processing:${requestId}:${accountId}`;
  return {
    id: processingMessageId,
    sessionId: groupId,
    senderIdentityId: cloudAgentCanonicalIdentityId(agentId, accountId),
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: '',
    content: {
      sender: agentDisplayName,
      senderOwnerAccountId: accountId,
      senderOwnerName: ownerDisplayName?.trim() || null,
      timestampMs: now,
      deliveryState: 'failed',
      sourceConversationId: cloudGroupAgentConversationId(groupId),
      requestId,
      replyToMessageId: requestId,
      ...(messageAction?.kind === 'thread' ? { messageAction } : {}),
      error: failureText,
      failureCode: cloudAgentSharedFailure(error, agentDisplayName).failureCode,
    },
    createdAtMs: now,
    parentMessageId: requestId,
    status: 'failed',
    sourceTransport: 'cloud-group-agent',
    sourceEventId: noProvider
      ? `cloud-group-agent-no-provider:${requestId}:${accountId}`
      : `cloud-group-agent-failed:${requestId}:${accountId}`,
  };
}

export async function handleCloudGroupAgentFailure(
  error: unknown,
  {
    context,
    setCanonicalState,
    runtime,
    stateOps,
    signal,
    publisher,
  }: HandleCloudGroupAgentFailureInput,
): Promise<void> {
  const { account, envelope } = context;
  const message = envelope.message;
  if (!message) return;
  runtime.turnIdsByRequestId.delete(message.id);
  const failureKey = cloudGroupAgentFailureKey(account.accountId, message.id);
  // One mention gets at most one failure reply from this Mac.
  if (publishedFailureKeys.has(failureKey)) {
    runtime.reportFailure('local-response', error);
    return;
  }
  // The generic refusal for a restricted requester is never answered in the
  // group: an error there would tell them about the restriction.
  if (isAgentUnavailableRefusal(error)) {
    setCanonicalState((current) => stateOps.removePendingRows(current, message.id, account.accountId) ?? current);
    return;
  }

  const responseCreatedAtMs = Date.now();
  const noProvider = isCloudAgentNoProviderConfiguredError(error);
  const responseMessageId = noProvider
    ? `msg:cloud-agent-no-provider:${message.id}:${account.accountId}`
    : `msg:cloud-agent-failed:${message.id}:${account.accountId}`;
  const hostedAgentName = stateOps.cleanText(message.targetCloudAgentName);
  const hostedAgentOwnerName = stateOps.cleanText(message.targetCloudAgentOwnerName)
    || stateOps.cleanText(account.displayName)
    || stateOps.cleanText(account.primaryEmail)
    || 'Cloud user';
  const agentId = cloudAgentId(message.targetCloudAgentId, account.accountId);
  const agentDisplayName = cloudAgentDisplayName(hostedAgentName);
  // Every member reads the published reply; only this owner's own row keeps the reason.
  const sharedFailure = cloudAgentSharedFailure(error, agentDisplayName);
  const failedResponseRequest = cloudGroupAgentFailureNoticeRequest({
    accountId: account.accountId,
    agentId,
    groupId: envelope.groupId,
    requestId: message.id,
    agentDisplayName,
    ownerDisplayName: hostedAgentOwnerName,
    error,
    messageAction: message.messageAction,
    now: responseCreatedAtMs,
  });
  const terminalUpsertSpan = beginChatPerformanceSpan(
    'cloud-agent-terminal-upsert',
  );
  let persistedResponse;
  try {
    persistedResponse = await upsertCanonicalMessageFast(
      failedResponseRequest,
    );
    finishChatPerformanceSpan(terminalUpsertSpan, {
      resultClass: 'failed',
    });
  } catch (persistError) {
    finishChatPerformanceSpan(terminalUpsertSpan, {
      resultClass: 'failed',
    });
    throw persistError;
  }
  if (signal?.aborted) return;
  const offlinePlaceholderId =
    `msg:cloud-agent-offline:${message.id}:${account.accountId}`;
  setCanonicalState((current) => {
    const withFailure = mergeCanonicalMessageRow(current, persistedResponse);
    if (!withFailure) return withFailure;
    const withoutPending = stateOps.removePendingRows(
      withFailure,
      message.id,
      account.accountId,
    ) ?? withFailure;
    return stateOps.removeTimeoutPlaceholder(
      withoutPending,
      offlinePlaceholderId,
    ) ?? withoutPending;
  });
  if (!noProvider) runtime.reportFailure('local-response', error);

  rememberPublishedFailure(failureKey);
  void publishCloudGroupAgentFailure({
    context,
    runtime,
    responseMessageId,
    responseCreatedAtMs,
    sharedFailure,
    agentDisplayName,
    agentId,
    signal,
    publisher,
  }).catch((fanoutError) => {
    runtime.reportFailure(
      noProvider ? 'no-provider-notice' : 'local-response',
      fanoutError,
    );
  });
}

async function publishCloudGroupAgentFailure({
  context,
  runtime,
  responseMessageId,
  responseCreatedAtMs,
  sharedFailure,
  agentDisplayName,
  agentId,
  signal,
  publisher,
}: {
  context: CloudGroupMessageControlContext;
  runtime: CloudGroupAgentRuntime;
  responseMessageId: string;
  responseCreatedAtMs: number;
  sharedFailure: { text: string; failureCode: CloudAgentFailureCode };
  agentDisplayName: string;
  agentId: string;
  signal?: AbortSignal;
  publisher?: Pick<CloudAuthClient, 'sendMessage'>;
}): Promise<void> {
  if (signal?.aborted) return;
  const {
    account,
    cloudMessage,
    envelope,
    groupSpaceId,
    participantByAccount,
  } = context;
  const message = envelope.message!;

  const session = await loadSession();
  if (!session?.token) return;
  const targetAccountIds = cloudGroupAgentResponseTargetAccountIds({
    localAccountId: account.accountId,
    envelope,
    requestCloudMessage: cloudMessage,
  });
  const responseBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: envelope.groupId,
    groupSpaceId,
    groupTitle: null,
    createdByAccountId: envelope.createdByAccountId,
    actor: cloudGroupSelfParticipant(account, 'person'),
    participants: [...participantByAccount.values()],
    message: {
      id: responseMessageId,
      senderAccountId: account.accountId,
      senderAgentId: agentId,
      text: sharedFailure.text,
      createdAtMs: responseCreatedAtMs,
      senderKind: 'agent',
      senderDisplayName: agentDisplayName,
      deliveryState: 'failed',
      failureCode: sharedFailure.failureCode,
      replyToMessageId: message.id,
      requestId: message.id,
      ...(message.messageAction?.kind === 'thread' ? { messageAction: message.messageAction } : {}),
    },
  });
  const fanoutSpan = beginChatPerformanceSpan(
    'cloud-agent-terminal-fanout',
  );
  const fanout = await publishCloudGroupAgentEnvelope({
    publisher,
    runtime,
    token: session.token,
    targetAccountIds,
    body: responseBody,
    sessionId: envelope.groupId,
    createdAtMs: responseCreatedAtMs,
    signal,
    // Keyed by the reply, not its text and time, so a resend is a no-op.
    clientMessageId: `group-agent-failure:${envelope.groupId}:${responseMessageId}`,
  });
  finishChatPerformanceSpan(fanoutSpan, {
    resultClass: fanout.failedCount === 0
      ? 'success'
      : fanout.sentCount > 0
        ? 'partial'
        : 'failed',
    recipientCount: targetAccountIds.length,
    errorCount: fanout.failedCount,
  });
  if (!signal?.aborted) void runtime.syncDiff();
  // One delivered copy reaches the whole group.
  if (fanout.sentCount === 0 && fanout.failedCount > 0) throw fanout.firstError;
}
