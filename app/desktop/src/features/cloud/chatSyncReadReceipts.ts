import { isBuiltInAccountId } from '@/features/systemAgent/systemAgentIdentity';
import type { ChatSyncConversation, ChatSyncMember, ChatSyncMessage } from './chatSyncTypes';

// Read receipts for the viewer's own messages. The server keeps a per-author
// watermark (`read_outbox_sequence`): the highest own message another member
// has read. Older servers omit it, so the highest read cursor among the other
// members the app knows stays as a fallback.

function sequence(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function chatSyncReadOutboxSequence(member: ChatSyncMember | null | undefined): number {
  if (!member) return 0;
  return Math.max(
    sequence(member.read_outbox_sequence),
    sequence((member as { readOutboxSequence?: unknown }).readOutboxSequence),
  );
}

/** Active people other than the viewer whose read cursors can mark an own message read. */
export function chatSyncOtherReaders(conversation: ChatSyncConversation, viewerAccountId: string): ChatSyncMember[] {
  return conversation.members.filter((member) => (
    member.account_id !== viewerAccountId
    && member.membership_state === 'active'
    && !isBuiltInAccountId(member.account_id)
  ));
}

/** The viewer's own messages at or below this sequence show two ticks. */
export function chatSyncOwnMessagesReadThrough(conversation: ChatSyncConversation, viewerAccountId: string): number {
  const viewer = conversation.members.find((member) => member.account_id === viewerAccountId);
  return chatSyncOtherReaders(conversation, viewerAccountId).reduce(
    (through, member) => Math.max(through, sequence(member.last_read_sequence)),
    chatSyncReadOutboxSequence(viewer),
  );
}

/** The watermark carried by a `read_cursor.updated` event, when it targets this conversation. */
export function chatSyncReadOutboxFromPayload(payload: unknown, conversationId: string): number | null {
  const event = record(payload);
  const outbox = record(event?.read_outbox ?? event?.readOutbox);
  if (!outbox) return null;
  const target = outbox.conversation_id ?? outbox.conversationId;
  if (typeof target === 'string' && target.trim() && target.trim() !== conversationId) return null;
  return sequence(outbox.sequence) || null;
}

/** Raises the viewer's watermark; a lower or equal value leaves the conversation unchanged. */
export function withChatSyncReadOutbox(conversation: ChatSyncConversation, value: number): ChatSyncConversation {
  const viewer = conversation.members.find((member) => member.account_id === conversation.preferences.account_id);
  if (!viewer || sequence(value) <= chatSyncReadOutboxSequence(viewer)) return conversation;
  return {
    ...conversation,
    members: conversation.members.map((member) => (
      member === viewer ? { ...member, read_outbox_sequence: sequence(value) } : member
    )),
  };
}

type SequenceRange = { after: number; through: number; ownOnly: boolean };

export type ChatSyncCursorEventResult = {
  conversation: ChatSyncConversation;
  /** Messages in these ranges may show a different receipt now. */
  ranges: SequenceRange[];
};

/** Applies a delivery or read cursor event, including the author's watermark. */
export function applyChatSyncCursorEvent(
  conversation: ChatSyncConversation,
  payload: unknown,
): ChatSyncCursorEventResult | null {
  let next = conversation;
  const ranges: SequenceRange[] = [];
  const cursor = record(record(payload)?.cursor);
  const member = cursor ? conversation.members.find((candidate) => candidate.account_id === cursor.account_id) : undefined;
  if (cursor && member) {
    const delivered = Math.max(member.last_delivered_sequence, sequence(cursor.last_delivered_sequence));
    const read = Math.max(member.last_read_sequence, sequence(cursor.last_read_sequence));
    if (delivered !== member.last_delivered_sequence || read !== member.last_read_sequence) {
      ranges.push(
        { after: member.last_delivered_sequence, through: delivered, ownOnly: false },
        { after: member.last_read_sequence, through: read, ownOnly: false },
      );
      next = {
        ...next,
        members: next.members.map((candidate) => (candidate === member
          ? { ...candidate, last_delivered_sequence: delivered, last_read_sequence: read }
          : candidate)),
      };
    }
  }
  const outbox = chatSyncReadOutboxFromPayload(payload, conversation.id);
  if (outbox !== null) {
    const viewerAccountId = conversation.preferences.account_id;
    const previous = chatSyncReadOutboxSequence(next.members.find((candidate) => candidate.account_id === viewerAccountId));
    const raised = withChatSyncReadOutbox(next, outbox);
    if (raised !== next) {
      ranges.push({ after: previous, through: outbox, ownOnly: true });
      next = raised;
    }
  }
  return next === conversation ? null : { conversation: next, ranges };
}

export function chatSyncCursorEventTouches(result: ChatSyncCursorEventResult, message: ChatSyncMessage): boolean {
  if (message.conversation_id !== result.conversation.id) return false;
  const viewerAccountId = result.conversation.preferences.account_id;
  return result.ranges.some((range) => (
    message.conversation_sequence > range.after
    && message.conversation_sequence <= range.through
    && (!range.ownOnly || message.sender_account_id === viewerAccountId)
  ));
}

/**
 * The delivered cursor only needs to move when it advances: a read cursor
 * implies delivery on the server, and a sequence already acknowledged (or
 * being acknowledged) needs no second request.
 */
export class ChatDeliveryAcknowledgements {
  private readonly claimed = new Map<string, number>();

  claim(conversation: ChatSyncConversation, value: number): (() => void) | null {
    const viewerAccountId = conversation.preferences.account_id;
    const viewer = conversation.members.find((member) => member.account_id === viewerAccountId);
    const key = `${viewerAccountId}\u0000${conversation.id}`;
    const previous = this.claimed.get(key);
    const known = Math.max(
      sequence(viewer?.last_delivered_sequence),
      sequence(viewer?.last_read_sequence),
      previous ?? 0,
    );
    if (sequence(value) <= known) return null;
    this.claimed.set(key, sequence(value));
    return () => {
      if (this.claimed.get(key) !== sequence(value)) return;
      if (previous === undefined) this.claimed.delete(key);
      else this.claimed.set(key, previous);
    };
  }
}
