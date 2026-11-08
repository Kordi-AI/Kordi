import {
  beginChatPerformanceSpan,
  finishChatPerformanceSpan,
} from '@/features/performance/chatPerformance';
import {
  cloudGroupAgentGuardDecision,
  loadCloudGroupAgentTargetMessages,
} from './cloudGroupAgentGuard';
import {
  cloudGroupSelfParticipant,
  encodeCloudGroupControl,
} from './cloudGroupMessages';
import type {
  CloudGroupAgentRuntime,
  CloudGroupMessageControlContext,
} from './cloudGroupControlContext';
import type { CloudGroupAgentHandoff } from './cloudGroupMentions';
import type { CloudGroupAgentPolicy } from './cloudGroupAgentControl.types';
import type { CloudAgentExecutionTool } from './cloudAgentMessages';
import type { CloudAgentFailureCode } from './cloudAgentFailureCode';
import type { CloudAuthClient } from './authClient';
import { cloudOperationUuid } from './chatSyncMapping';
import { parseCloudGroupControl } from './cloudGroupMessages';

export async function publishCloudGroupAgentTerminalAfterGuards({
  context,
  runtime,
  policy,
  token,
  targetAccountIds,
  responseMessageId,
  responseCreatedAtMs,
  responseText,
  responseDeliveryState,
  failureCode,
  responseTools,
  responseTiming,
  requestId,
  agentId,
  agentDisplayName,
  agentHandoff,
  signal,
  publisher,
}: {
  context: CloudGroupMessageControlContext;
  runtime: CloudGroupAgentRuntime;
  policy: CloudGroupAgentPolicy;
  token: string;
  targetAccountIds: string[];
  responseMessageId: string;
  responseCreatedAtMs: number;
  responseText: string;
  responseDeliveryState: 'complete' | 'failed';
  /** A failed reply's category; its text is the neutral line every member reads. */
  failureCode?: CloudAgentFailureCode;
  responseTools: CloudAgentExecutionTool[];
  /** The turn's own timing, so a follow-up reply shows how long it worked. */
  responseTiming?: { startedAtMs?: number | null; completedAtMs?: number | null };
  /** A follow-up reply carries its own request id so it never replaces the first reply. */
  requestId?: string;
  agentId: string;
  agentDisplayName: string;
  agentHandoff: CloudGroupAgentHandoff | null;
  signal: AbortSignal;
  publisher?: Pick<CloudAuthClient, 'sendMessage'>;
}): Promise<void> {
  if (signal.aborted) return;
  const {
    account,
    envelope,
    groupSpaceId,
    participantByAccount,
  } = context;
  const message = envelope.message!;
  const guardSpan = beginChatPerformanceSpan(
    'cloud-agent-ownership-guard',
  );
  const guardDecision = publisher ? { requestAlreadyOwned: false, resultClass: 'success' as const } : await cloudGroupAgentGuardDecision({
    loadMessages: () => loadCloudGroupAgentTargetMessages(
      runtime,
      token,
      targetAccountIds,
    ),
    fallbackOwnsRequest: () => policy.fallbackRunOwnsRequest({
      client: runtime.client,
      token,
      requestMessageId: message.id,
    }),
    responseExists: (messages) => policy.responseExists({
      localAccountId: account.accountId,
      requestMessageId: message.id,
      messages,
      groupRows: runtime.messageIndex().groupRows,
      ignoreFailedCloudFallback: responseDeliveryState === 'complete',
    }),
  });
  finishChatPerformanceSpan(guardSpan, {
    resultClass: guardDecision.resultClass,
  });
  if (signal.aborted) return;
  const fanoutSpan = beginChatPerformanceSpan(
    'cloud-agent-terminal-fanout',
  );
  if (!guardDecision.requestAlreadyOwned) {
    const fanout = await publishCloudGroupAgentEnvelope({
      publisher,
      runtime,
      token,
      targetAccountIds,
      body: encodeCloudGroupControl({
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
          text: responseText,
          createdAtMs: responseCreatedAtMs,
          senderKind: 'agent',
          senderDisplayName: agentDisplayName,
          deliveryState: responseDeliveryState,
          ...(responseDeliveryState === 'failed' && failureCode ? { failureCode } : {}),
          replyToMessageId: message.id,
          requestId: requestId ?? message.id,
          ...(message.messageAction?.kind === 'thread' ? { messageAction: message.messageAction } : {}),
          structuredContent: cloudGroupAgentStructuredContent(responseTools, responseTiming),
          ...(agentHandoff ?? {}),
        },
      }),
      sessionId: envelope.groupId,
      createdAtMs: responseCreatedAtMs,
      signal,
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
  } else {
    finishChatPerformanceSpan(fanoutSpan, {
      resultClass: 'owned-elsewhere',
      recipientCount: targetAccountIds.length,
    });
  }
  if (!signal.aborted) void runtime.syncDiff();
}

function cloudGroupAgentStructuredContent(
  tools: CloudAgentExecutionTool[],
  timing?: { startedAtMs?: number | null; completedAtMs?: number | null },
): Record<string, unknown> | null {
  const content: Record<string, unknown> = tools.length > 0 ? { tools } : {};
  if (typeof timing?.startedAtMs === 'number') content.startedAtMs = timing.startedAtMs;
  if (typeof timing?.completedAtMs === 'number') content.completedAtMs = timing.completedAtMs;
  return Object.keys(content).length > 0 ? content : null;
}

export async function publishCloudGroupAgentEnvelope({
  runtime,
  token,
  targetAccountIds,
  body,
  sessionId,
  createdAtMs,
  signal,
  publisher,
  clientMessageId,
}: {
  runtime: CloudGroupAgentRuntime;
  token: string;
  targetAccountIds: string[];
  body: string;
  sessionId: string;
  createdAtMs: number;
  signal?: AbortSignal;
  publisher?: Pick<CloudAuthClient, 'sendMessage'>;
  /** A stable id for a chat send, so sending the same reply again is a no-op. */
  clientMessageId?: string;
}): Promise<{ sentCount: number; failedCount: number; firstError?: unknown }> {
  const sent = await Promise.allSettled(targetAccountIds.map((targetAccountId) => (
    (publisher ?? runtime.client).sendMessage(token, targetAccountId, body, {
      ...(publisher
        ? { clientMessageId: cloudOperationUuid(`group-agent:${sessionId}:${parseCloudGroupControl(body)?.message?.id ?? createdAtMs}`) }
        : clientMessageId ? { clientMessageId } : {}),
      sessionId,
      clientCreatedAt: new Date(createdAtMs).toISOString(),
      conversationKind: 'group',
      memberAccountIds: targetAccountIds,
    })
  )));
  sent.forEach((result) => {
    if (result.status === 'fulfilled' && !signal?.aborted) {
      runtime.mergeMessage(result.value);
    }
  });
  const failures = sent.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  return {
    sentCount: sent.length - failures.length,
    failedCount: failures.length,
    ...(failures.length > 0 ? { firstError: failures[0].reason } : {}),
  };
}

/**
 * Publishes the processing placeholder. It only shows that the agent is
 * working, so a failure is reported and never ends the turn: the terminal
 * reply is published on its own, also when no placeholder reached the cloud.
 */
export async function publishCloudGroupAgentProcessingBestEffort(
  input: Parameters<typeof publishCloudGroupAgentEnvelope>[0],
  reportFailure: (error: unknown) => void,
): Promise<void> {
  try {
    const result = await publishCloudGroupAgentEnvelope(input);
    if (result.failedCount > 0) reportFailure(result.firstError);
  } catch (error) {
    reportFailure(error);
  }
}
