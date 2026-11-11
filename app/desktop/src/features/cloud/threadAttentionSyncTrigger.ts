import type { ApplyChatSyncRequest } from '@/lib/desktopChatSync';
import { ACCOUNT_HINT_EVENT_TYPES } from './accountHintEvents';
import type { ChatSyncEvent } from './chatSyncTypes';

// What `GET /v2/chat/attention` reads, from the query in
// bridges/cloud-server/src/chat_sync/store/thread_attention.rs:
// - the viewer's active membership rows (`membership_state`, `muted_until`)
//   and the viewer's conversation read cursor (`last_read_sequence`, which
//   decides unread top-level messages);
// - messages: new rows, `deleted_at`, content (text, attachments, voice,
//   hidden or synchronization-only flags) and attachment rows, for replies
//   and for their thread roots;
// - the viewer's thread read cursors (thread_reads.rs; advancing one sends no
//   sync event, so the poll and the local read refresh cover it);
// - per-viewer hidden messages and the viewer's blocks.
// Nothing reads another member's cursors, any delivery cursor, the read
// watermark (`read_outbox`, receipts.rs), reactions or list preferences.

/** Events that change one of those inputs. */
const ATTENTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'message.created',
  'message.updated',
  'message.deleted',
  // A message the viewer hid for themselves, or that lost its last visible photo.
  'message.hidden',
  // Older servers stream agent output through these; the content can change.
  'generation.updated',
  'generation.completed',
  'generation.failed',
  'conversation.created',
  'membership.updated',
  'membership.removed',
  // A catch-all announcement (organization.rs) that also accompanies a member
  // leaving and ownership moves; rare, so it refetches.
  'conversation.updated',
  // `muted_until`; removing a session also clears it (preferences.rs).
  'session.muted',
  'session.unmuted',
  'session.deleted',
  // Blocking and unblocking (safety/block_routes.rs) announce only this.
  'account.directory.changed',
]);

/** Events whose server writes touch nothing the attention query reads. */
const NEUTRAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'delivery_cursor.updated',
  'reaction.updated',
  'conversation.preferences.updated',
  'session.hidden',
  'session.unhidden',
  'session.pinned',
  'session.unpinned',
  'session.pin.updated',
  'session.marked_unread',
  'session.unmarked_unread',
  'session.visibility.snapshot',
  'session-forked',
  'group_space.pinned',
  'group_space.unpinned',
  'account.profile.updated',
  'agent.definition.upserted',
  'agent.definition.archived',
  'agent.directory.changed',
  'provider-auth.updated',
  'task.upsert',
  'artifact.upsert',
  'artifact.archived',
  'device.added',
  'device.confirmed',
  'device.revoked',
  'device.renamed',
  'call.created',
  'call.updated',
  'document.updated',
  'digest.updated',
  ...ACCOUNT_HINT_EVENT_TYPES,
]);

function cursorAccountId(payload: unknown): string | null {
  const cursor = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { cursor?: unknown }).cursor
    : null;
  const accountId = cursor && typeof cursor === 'object' && !Array.isArray(cursor)
    ? (cursor as { account_id?: unknown }).account_id
    : null;
  return typeof accountId === 'string' && accountId.trim() ? accountId.trim() : null;
}

function eventMayChangeThreadAttention(event: Pick<ChatSyncEvent, 'type' | 'payload'>, viewerAccountId: string) {
  if (event.type === 'read_cursor.updated') {
    // The viewer's own read moves their conversation read cursor. Another
    // member's read reaches the viewer only as an author's watermark.
    const reader = cursorAccountId(event.payload);
    return !reader || reader === viewerAccountId.trim();
  }
  if (ATTENTION_EVENT_TYPES.has(event.type)) return true;
  return !NEUTRAL_EVENT_TYPES.has(event.type);
}

/**
 * Whether a committed chat sync batch can change what `GET /v2/chat/attention`
 * returns, mirroring the query in
 * `bridges/cloud-server/src/chat_sync/store/thread_attention.rs`. A bootstrap
 * (which also covers a sync gap, a reset and a directory refresh), a history
 * page without events, and any event type not known to be neutral refetch.
 */
export function chatSyncBatchMayChangeThreadAttention(
  batch: Pick<ApplyChatSyncRequest, 'accountId' | 'bootstrap' | 'events'>,
): boolean {
  if (batch.bootstrap) return true;
  const events = batch.events ?? [];
  if (events.length === 0) return true;
  return events.some((event) => eventMayChangeThreadAttention(event, batch.accountId));
}
