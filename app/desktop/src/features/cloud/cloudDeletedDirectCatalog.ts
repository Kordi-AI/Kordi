import { useCallback, useSyncExternalStore } from 'react';

import { isGroupClosedError, PEER_ACCOUNT_DELETED_LINE } from '@/features/chat/closedGroup';
import { isBuiltInAccountId, KORDI_DELETED_ACCOUNT_ID } from '@/features/systemAgent/systemAgentIdentity';
import { CloudAuthError } from './cloudAuthError';
import type { ChatSyncRequest } from './chatSyncState';
import type { ChatSyncConversation, ChatSyncEvent } from './chatSyncTypes';

const DIRECT_PERSON_SESSION_PREFIX = 'session:direct-person:';
const CONVERSATION_PATH = /^\/v2\/chat\/conversations\/([^/?]+)/;

/**
 * A direct conversation the viewer kept after the other person's account was
 * deleted (docs/development/account-deletion.md#direct-conversations). It is
 * read-only. Its session id still names the deleted account, and that id stays
 * the chat's peer here, so the chat keeps its id and local copies stay attached.
 */
export type CloudDeletedDirectConversation = {
  conversationId: string;
  sessionId: string;
  peerAccountId: string;
  closedAt: string;
};

type DirectConversationShape = Pick<ChatSyncConversation, 'kind' | 'legacy_session_id' | 'members'>;

/**
 * The deleted account a kept direct conversation was with, named by its
 * session id, or null for any other conversation. Every member keeps a row,
 * active, left or removed; only a deleted account loses it. This holds before the
 * close reaches the device too, so both sides of the chat stay on one peer.
 * The viewer must still be an active member: a chat emptied by the other
 * person's own deletion loses that row too, but removes the viewer.
 */
export function deletedDirectPeerAccountId(
  conversation: DirectConversationShape,
  viewerAccountId: string | null | undefined,
): string | null {
  const viewer = viewerAccountId?.trim() ?? '';
  const sessionId = conversation.legacy_session_id?.trim() ?? '';
  if (conversation.kind !== 'direct' || !viewer || !sessionId.startsWith(DIRECT_PERSON_SESSION_PREFIX)) return null;
  const accountIds = sessionId.slice(DIRECT_PERSON_SESSION_PREFIX.length).split(':');
  const peer = accountIds.length === 2 && accountIds.includes(viewer)
    ? accountIds.find((accountId) => accountId !== viewer) ?? ''
    : '';
  if (!peer || peer === KORDI_DELETED_ACCOUNT_ID || isBuiltInAccountId(peer)) return null;
  const viewerActive = conversation.members.some((member) => (
    member.account_id === viewer && member.membership_state === 'active'
  ));
  return viewerActive && !conversation.members.some((member) => member.account_id === peer) ? peer : null;
}

/** Conversations an event batch takes from the viewer: its own removal, or a deleted session. */
function revokedByEvents(viewer: string, events: readonly ChatSyncEvent[]) {
  const conversationIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const event of events) {
    const removed = event.payload?.account_id;
    if (event.type === 'membership.removed' && event.conversation_id && (typeof removed !== 'string' || removed === viewer)) {
      conversationIds.add(event.conversation_id);
    }
    if (event.type === 'session.deleted' && typeof event.payload?.sessionId === 'string') sessionIds.add(event.payload.sessionId);
  }
  return (entry: CloudDeletedDirectConversation) => conversationIds.has(entry.conversationId) || sessionIds.has(entry.sessionId);
}

export function cloudDeletedDirectConversation(
  conversation: ChatSyncConversation,
  viewerAccountId: string,
): CloudDeletedDirectConversation | null {
  const peerAccountId = deletedDirectPeerAccountId(conversation, viewerAccountId);
  const sessionId = conversation.legacy_session_id?.trim();
  if (!peerAccountId || !sessionId) return null;
  return {
    conversationId: conversation.id,
    sessionId,
    peerAccountId,
    // The close follows the member change in the same server transaction.
    closedAt: conversation.closed?.closed_at?.trim() || conversation.updated_at,
  };
}

const EMPTY: readonly CloudDeletedDirectConversation[] = Object.freeze([]);
const entriesByAccountId = new Map<string, readonly CloudDeletedDirectConversation[]>();
const listeners = new Set<() => void>();

/**
 * Records the kept direct conversations among `conversations` once the
 * account's sync committed them. `complete` lists every conversation of the
 * account (a bootstrap or the local copy), so one missing from it is dropped;
 * any other batch changes only the conversations it names. A removal of the
 * viewer (`membership.removed`, whose payload has no conversation) or a deleted
 * session among the batch's `events` drops the conversation.
 */
export function publishCloudDeletedDirectConversations(
  accountId: string,
  conversations: readonly ChatSyncConversation[],
  { complete = false, events = [] }: { complete?: boolean; events?: readonly ChatSyncEvent[] } = {},
): void {
  const viewer = accountId.trim();
  if (!viewer) return;
  const current = entriesByAccountId.get(viewer) ?? EMPTY;
  const byId = new Map(complete ? [] : current.map((entry) => [entry.conversationId, entry]));
  for (const conversation of conversations) {
    const owner = conversation.preferences?.account_id?.trim();
    if (owner && owner !== viewer) continue;
    const entry = cloudDeletedDirectConversation(conversation, viewer);
    if (entry) byId.set(entry.conversationId, entry);
    else byId.delete(conversation.id);
  }
  const revoked = revokedByEvents(viewer, events);
  const next = [...byId.values()].filter((entry) => !revoked(entry))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  // An unchanged list keeps its snapshot, so nothing re-renders.
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  entriesByAccountId.set(viewer, next.length > 0 ? next : EMPTY);
  for (const listener of listeners) listener();
}

export function cloudDeletedDirectConversations(accountId: string | null | undefined) {
  return entriesByAccountId.get(accountId?.trim() ?? '') ?? EMPTY;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCloudDeletedDirectConversations(accountId: string | null | undefined) {
  const snapshot = useCallback(() => cloudDeletedDirectConversations(accountId), [accountId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * The server refuses every write to a kept direct conversation with
 * `group_closed` and the closed group's wording. Its requests say the account
 * was deleted instead; the code stays, so closed handling still applies.
 */
export function withDeletedDirectRefusals(
  request: ChatSyncRequest,
  conversationById: (conversationId: string) => ChatSyncConversation | undefined,
): ChatSyncRequest {
  return async <TResponse,>(path: string, init: RequestInit, fallbackMessage: string): Promise<TResponse> => {
    try {
      return await request<TResponse>(path, init, fallbackMessage);
    } catch (error) {
      const conversationId = CONVERSATION_PATH.exec(path)?.[1];
      const conversation = conversationId ? conversationById(decodeURIComponent(conversationId)) : undefined;
      if (!(error instanceof CloudAuthError) || !isGroupClosedError(error) || !conversation
        || !deletedDirectPeerAccountId(conversation, conversation.preferences?.account_id)) throw error;
      throw new CloudAuthError(error.code, PEER_ACCOUNT_DELETED_LINE, error.status, error.retryAfterSeconds, {
        serverCode: error.serverCode ?? undefined,
      });
    }
  };
}
