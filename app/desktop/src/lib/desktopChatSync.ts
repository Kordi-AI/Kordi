import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import type { ChatSyncConversation, ChatSyncEvent, ChatSyncMessage } from '@/features/cloud/authClient';
import { invokeDesktop, isNativeDesktopShell } from './desktop';

export type ChatSyncLocalState = {
  pinEvents?: ChatSyncEvent[];
  pinCacheReady?: boolean;
  visibility?: import('@/features/cloud/cloudSessionListClient').CloudSessionVisibility | null;
  accountId: string;
  cursor: string | null;
  lastStreamSeq: number;
  conversations: ChatSyncConversation[];
  messages: ChatSyncMessage[];
};

export type ChatSyncCursorState = {
  accountId: string;
  cursor: string | null;
  lastStreamSeq: number;
};

export type ChatSyncConversationHead = {
  conversationId: string;
  sessionId: string;
  latestMessageSequence: number;
  lastReadSequence: number;
  unreadCount: number;
};

export type ChatSyncApplyResult = ChatSyncCursorState & {
  changedConversationHeads: ChatSyncConversationHead[];
};

export type ChatSyncConversationCoverage = {
  conversationId: string;
  earliestSequence: number;
  latestSequence: number;
  messageCount: number;
};

export type ChatSyncMessageRef = Pick<
  ChatSyncMessage,
  'id' | 'client_message_id' | 'conversation_id'
>;

export type ChatSyncMessagePage = {
  conversationId: string;
  messages: ChatSyncMessage[];
  nextAfterSequence: number | null;
  hasMore: boolean;
};

export type ChatSyncRecoveryMessageIds = {
  conversationId: string;
  messageIds: string[];
};

export type ApplyChatSyncRequest = {
  accountId: string;
  /** Scope captured before fetching. Browser writes reject a changed or omitted scope. */
  expectedOrganizationId?: string | null;
  bootstrap: boolean;
  cursor?: string | null;
  lastStreamSeq?: number | null;
  conversations?: ChatSyncConversation[];
  messages?: ChatSyncMessage[];
  events?: ChatSyncEvent[];
};

export type ChatSyncOutboxPayload = {
  peerAccountId: string;
  body: string;
  options: Record<string, unknown>;
};

export type ChatSyncPendingOperation = {
  accountId: string;
  operationId: string;
  payload: ChatSyncOutboxPayload;
  attemptCount: number;
  nextAttemptAtMs: number;
  lastError: string | null;
};

export const CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT =
  'kordi.chat-sync.local-state-changed';

/** The `detail` of a commit's change event. An event without it says only that something changed. */
export type ChatSyncLocalStateChange = { batch: ApplyChatSyncRequest };
export type ChatSyncLocalStateChangedEvent = Event & { detail?: ChatSyncLocalStateChange | null };

export function publishChatSyncLocalStateChanged(
  target: Pick<EventTarget, 'dispatchEvent'> | null =
    typeof window === 'undefined' ? null : window,
  change?: ChatSyncLocalStateChange,
) {
  // A plain Event with the detail attached: `Event` is the global every
  // listener's realm already provides, which `CustomEvent` may not be.
  const event: ChatSyncLocalStateChangedEvent = new Event(CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT);
  if (change) event.detail = change;
  target?.dispatchEvent(event);
}

export async function loadChatSyncLocalState(accountId: string) {
  if ((!isNativeDesktopShell() && !isBrowserAppRuntime())) return null;
  return invokeDesktop<ChatSyncLocalState>('desktop_chat_sync_load', { accountId });
}

export async function loadChatSyncCursor(accountId: string) {
  if ((!isNativeDesktopShell() && !isBrowserAppRuntime())) return null;
  return invokeDesktop<ChatSyncCursorState>('desktop_chat_sync_cursor', { accountId });
}

export async function loadChatSyncCoverage(accountId: string) {
  if ((!isNativeDesktopShell() && !isBrowserAppRuntime())) return [];
  return invokeDesktop<ChatSyncConversationCoverage[]>('desktop_chat_sync_coverage', { accountId });
}

export function chatSyncHistoryIsComplete(
  conversations: readonly ChatSyncConversation[],
  coverage: readonly ChatSyncConversationCoverage[],
) {
  const byConversationId = new Map(
    coverage.map((row) => [row.conversationId, row]),
  );
  return conversations.every((conversation) => {
    const target = conversation.latest_message_sequence;
    if (target <= 0) return true;
    const viewer = conversation.members.find(
      (member) => member.account_id === conversation.preferences.account_id,
    );
    if ((viewer?.last_delivered_sequence ?? 0) >= target) return true;
    const row = byConversationId.get(conversation.id);
    return row?.earliestSequence === 1
      && row.latestSequence === target
      && row.messageCount === target;
  });
}

export async function waitForCompleteChatSyncHistory(
  accountId: string,
  shouldContinue: () => boolean,
  includes: (conversation: ChatSyncConversation) => boolean = () => true,
) {
  while (shouldContinue()) {
    const [conversations, coverage] = await Promise.all([
      loadChatSyncConversations(accountId),
      loadChatSyncCoverage(accountId),
    ]);
    const relevant = conversations.filter(includes);
    if (chatSyncHistoryIsComplete(relevant, coverage)) {
      return relevant;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_000));
  }
  return null;
}

export async function loadChatSyncConversations(accountId: string) {
  if ((!isNativeDesktopShell() && !isBrowserAppRuntime())) return [];
  return invokeDesktop<ChatSyncConversation[]>('desktop_chat_sync_conversations', { accountId });
}

export async function loadChatSyncUnreadCounts(accountId: string) {
  if ((!isNativeDesktopShell() && !isBrowserAppRuntime())) return [];
  return invokeDesktop<ChatSyncConversationHead[]>('desktop_chat_sync_unread_counts', { accountId });
}

export async function loadChatSyncMessageRefs(accountId: string, conversationIds: string[]) {
  if ((!isNativeDesktopShell() && !isBrowserAppRuntime()) || conversationIds.length === 0) return [];
  return invokeDesktop<ChatSyncMessageRef[]>('desktop_chat_sync_message_refs', {
    accountId,
    conversationIds,
  });
}

export async function loadChatSyncMessagesPage(
  accountId: string,
  conversationId: string,
  afterSequence: number | null = null,
  limit = 100,
) {
  if ((!isNativeDesktopShell() && !isBrowserAppRuntime())) return null;
  return invokeDesktop<ChatSyncMessagePage>('desktop_chat_sync_messages_page', {
    accountId,
    conversationId,
    afterSequence,
    limit,
  });
}

export async function loadChatSyncRecoveryMessageIds(
  accountId: string,
  conversationId: string,
) {
  if ((!isNativeDesktopShell() && !isBrowserAppRuntime())) return null;
  return invokeDesktop<ChatSyncRecoveryMessageIds>(
    'desktop_chat_sync_recovery_message_ids',
    { accountId, conversationId },
  );
}

export async function loadChatSyncDeletedMessageIds(accountId: string): Promise<string[]> {
  if ((!isNativeDesktopShell() && !isBrowserAppRuntime())) return [];
  return invokeDesktop<string[]>('desktop_chat_sync_deleted_message_ids', { accountId });
}

export async function applyChatSyncLocalBatch(request: ApplyChatSyncRequest) {
  if ((!isNativeDesktopShell() && !isBrowserAppRuntime())) return null;
  const result = await invokeDesktop<ChatSyncApplyResult>('desktop_chat_sync_apply', { request });
  if (request.bootstrap || request.conversations?.length || request.messages?.length
    || request.events?.length || result.changedConversationHeads.length) {
    publishChatSyncLocalStateChanged(undefined, { batch: request });
  }
  return result;
}

export async function enqueueChatSyncOutbox(
  accountId: string,
  operationId: string,
  payload: ChatSyncOutboxPayload,
  expectedOrganizationId?: string | null,
) {
  if ((!isNativeDesktopShell() && !isBrowserAppRuntime())) return;
  await invokeDesktop<void>('desktop_chat_sync_outbox_enqueue', {
    request: { accountId, operationId, payload, expectedOrganizationId },
  });
}

export async function dueChatSyncOutbox(accountId: string, expectedOrganizationId?: string | null) {
  if ((!isNativeDesktopShell() && !isBrowserAppRuntime())) return [];
  return invokeDesktop<ChatSyncPendingOperation[]>(
    'desktop_chat_sync_outbox_due',
    { accountId, expectedOrganizationId },
  );
}

export async function completeChatSyncOutbox(accountId: string, operationId: string, expectedOrganizationId?: string | null) {
  if ((!isNativeDesktopShell() && !isBrowserAppRuntime())) return;
  await invokeDesktop<void>('desktop_chat_sync_outbox_complete', { accountId, operationId, expectedOrganizationId });
}

export async function failChatSyncOutbox(
  accountId: string,
  operationId: string,
  error: string,
  retryable: boolean,
  expectedOrganizationId?: string | null,
) {
  if ((!isNativeDesktopShell() && !isBrowserAppRuntime())) return;
  await invokeDesktop<void>('desktop_chat_sync_outbox_fail', {
    request: { accountId, operationId, error, retryable, expectedOrganizationId },
  });
}
