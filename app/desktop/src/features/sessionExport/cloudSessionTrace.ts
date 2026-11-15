import type { CloudAccount, CloudMessage } from '@/features/cloud/authClient';
import { cloudMessageFromChatSync } from '@/features/cloud/chatSyncMapping';
import type { ChatSyncConversation, ChatSyncMessage } from '@/features/cloud/chatSyncTypes';
import { buildCloudDesktopCollaborationState } from '@/features/cloud/cloudCollaborationState';
import { cloudGroupHistoryMessage } from '@/features/cloud/cloudGroupHistoryMessage';
import { parseCloudGroupControl } from '@/features/cloud/cloudGroupMessages';
import { cloudMessageMetadataOnly } from '@/features/cloud/cloudMessageCache';
import { mapCollaborationConversationToViewModel } from '@/features/collaboration/transcript';
import type { Contact, Message } from '@/kordi-app/types';

export const CLOUD_TRACE_PAGE_SIZE = 200;

export type CloudHistoryPage = {
  messages: ChatSyncMessage[];
  nextBeforeSequence: number | null;
  hasMore: boolean;
};

export type CloudSessionTraceDeps = {
  account: CloudAccount;
  contacts: readonly Contact[];
  findConversation: (sessionId: string) => Promise<ChatSyncConversation | null>;
  fetchPage: (conversationId: string, beforeSequence: number | undefined, limit: number) => Promise<CloudHistoryPage>;
  /** Messages this viewer deleted for themselves. */
  deletedMessageIds?: ReadonlySet<string>;
};

/** Reads every server page of a conversation, newest first, until the server reports no more. */
export async function collectCloudHistoryRows(
  conversationId: string,
  fetchPage: CloudSessionTraceDeps['fetchPage'],
): Promise<ChatSyncMessage[]> {
  const pages: ChatSyncMessage[][] = [];
  let before: number | undefined;
  for (;;) {
    const page = await fetchPage(conversationId, before, CLOUD_TRACE_PAGE_SIZE);
    pages.push(page.messages);
    if (!page.hasMore) break;
    const next = page.nextBeforeSequence;
    if (!next || (before !== undefined && next >= before)) {
      throw new Error('Chat history did not advance its sequence cursor.');
    }
    before = next;
  }
  const byId = new Map<string, ChatSyncMessage>();
  for (const row of pages.flat()) byId.set(row.id, row);
  return [...byId.values()].sort((left, right) => (
    left.conversation_sequence - right.conversation_sequence || left.id.localeCompare(right.id)
  ));
}

function coveredKeys(messages: readonly Message[]) {
  const ids = new Set<string>();
  const sequences = new Set<number>();
  for (const message of messages) {
    for (const id of [message.id, message.entryId, message.clientMessageId, message.reactionTargetMessageId, ...(message.replyAliasIds ?? [])]) {
      const trimmed = id?.trim();
      if (trimmed) ids.add(trimmed);
    }
    if (typeof message.conversationSequence === 'number') sequences.add(message.conversationSequence);
  }
  return { ids, sequences };
}

function isPendingAgentRow(message: NonNullable<ReturnType<typeof parseCloudGroupControl>>['message']) {
  const state = message?.deliveryState?.trim().toLowerCase();
  return message?.senderKind === 'agent' && (state === 'processing' || state === 'queued');
}

function groupRowMessages(
  rows: readonly { snapshot: ChatSyncMessage; wire: CloudMessage }[],
  accountId: string,
  covered: ReturnType<typeof coveredKeys>,
): Message[] {
  return rows.flatMap(({ snapshot, wire }) => {
    const envelope = parseCloudGroupControl(wire.body);
    const payload = envelope?.message;
    // Membership, title and avatar controls are not transcript rows; a reply
    // that is still waiting has no content yet.
    if (!envelope || envelope.kind !== 'group-message' || !payload || isPendingAgentRow(payload)) return [];
    if (covered.ids.has(snapshot.id) || covered.ids.has(payload.id) || covered.sequences.has(snapshot.conversation_sequence)) return [];
    const message = cloudGroupHistoryMessage({ wire, envelope, snapshot }, accountId);
    if (!message) return [];
    return [{
      ...message,
      senderIdentityId: payload.senderKind === 'agent' && payload.senderAgentId
        ? payload.senderAgentId
        : `human:${payload.senderAccountId}`,
      senderType: payload.senderKind === 'agent' ? 'agent' : 'human',
      replyToMessageId: payload.replyToMessageId ?? undefined,
      conversationSequence: snapshot.conversation_sequence,
    }];
  });
}

/** The transcript of a direct or agent conversation, through the same pipeline the chat view uses. */
function directConversationMessages(
  sessionId: string,
  wires: readonly CloudMessage[],
  deps: CloudSessionTraceDeps,
  localAgentLabel: string,
): Message[] | null {
  const accountId = deps.account.accountId;
  const messagesByPeer: Record<string, CloudMessage[]> = {};
  for (const message of wires) {
    const peerId = message.fromAccountId === accountId ? message.toAccountId : message.fromAccountId;
    (messagesByPeer[peerId] ??= []).push(message);
  }
  const state = buildCloudDesktopCollaborationState({
    account: deps.account,
    contacts: [...deps.contacts],
    messagesByPeer,
    localAgentLabel,
  });
  const conversation = state.conversations.find((candidate) => (
    candidate.canonicalSessionId === sessionId || candidate.id === sessionId
  ));
  if (!conversation) return null;
  const host = state.hosts.find((candidate) => candidate.id === conversation.hostId);
  return mapCollaborationConversationToViewModel(conversation, host, localAgentLabel).messages;
}

function timelineMs(message: Message) {
  return typeof message.timestampMs === 'number' && Number.isFinite(message.timestampMs)
    ? message.timestampMs
    : null;
}

/** Inserts rows into an ordered transcript by time, keeping the transcript's own order. */
export function mergeTranscriptByTime(base: readonly Message[], extra: readonly Message[]): Message[] {
  if (!extra.length) return [...base];
  const pending = [...extra].sort((left, right) => (timelineMs(left) ?? 0) - (timelineMs(right) ?? 0));
  const merged: Message[] = [];
  for (const message of base) {
    const at = timelineMs(message);
    while (at !== null && pending.length && (timelineMs(pending[0]) ?? 0) < at) merged.push(pending.shift()!);
    merged.push(message);
  }
  return [...merged, ...pending];
}

/**
 * Completes a cloud conversation's transcript from the server, which holds
 * every message even when this device cached only part of it. Rows this
 * device already renders keep their rendered form; the server fills the rest.
 * Returns null when the session has no server conversation.
 */
export async function completeCloudTranscript(
  sessionId: string,
  rendered: readonly Message[],
  deps: CloudSessionTraceDeps,
  localAgentLabel: string,
): Promise<Message[] | null> {
  const conversation = await deps.findConversation(sessionId);
  if (!conversation) return null;
  const accountId = deps.account.accountId;
  const deleted = deps.deletedMessageIds ?? new Set<string>();
  const rows = (await collectCloudHistoryRows(conversation.id, deps.fetchPage))
    .filter((row) => !row.deleted_at && !deleted.has(row.id))
    .map((snapshot) => ({
      snapshot,
      wire: cloudMessageMetadataOnly(cloudMessageFromChatSync(snapshot, conversation, accountId)),
    }));
  const covered = coveredKeys(rendered);
  if (conversation.kind === 'group') {
    return mergeTranscriptByTime(rendered, groupRowMessages(rows, accountId, covered));
  }
  const uncovered = new Set(rows
    .filter(({ snapshot }) => !covered.ids.has(snapshot.id) && !covered.ids.has(snapshot.client_message_id)
      && !covered.sequences.has(snapshot.conversation_sequence))
    .map(({ snapshot }) => snapshot.id));
  if (!uncovered.size) return [...rendered];
  const direct = directConversationMessages(sessionId, rows.map(({ wire }) => wire), deps, localAgentLabel);
  if (!direct) {
    if (rendered.length) return [...rendered];
    throw new Error('This chat\'s history could not be read.');
  }
  if (!rendered.length) return direct;
  return mergeTranscriptByTime(rendered, direct.filter((message) => (
    [message.id, message.reactionTargetMessageId].some((id) => Boolean(id && uncovered.has(id)))
  )));
}
