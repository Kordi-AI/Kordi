import type { ChatSyncConversation } from './chatSyncTypes';
import { cloudGroupCatalogRow } from './cloudGroupCatalog';

const CLOUD_GROUP_CATALOG_SYNC_EVENT = 'kordi-cloud-group-catalog-sync';
type CatalogDetail = { accountId: string; conversations: ChatSyncConversation[] };

/** Publish only after the account's sync batch has been committed locally. */
export function publishCloudGroupCatalog(
  accountId: string,
  conversations: ChatSyncConversation[],
): void {
  const groups = conversations.filter(conversation => conversation.kind === 'group');
  if (typeof window === 'undefined' || groups.length === 0) return;
  window.dispatchEvent(new CustomEvent<CatalogDetail>(CLOUD_GROUP_CATALOG_SYNC_EVENT, {
    detail: { accountId, conversations: groups },
  }));
}

/**
 * A catalog row creates a missing session, and re-applies to an existing one
 * only to carry a close that has not reached it yet.
 */
export function cloudGroupCatalogRowNeedsApply(
  row: NonNullable<ReturnType<typeof cloudGroupCatalogRow>>,
  hasSession: (sessionId: string) => boolean,
  isSessionClosed: (sessionId: string) => boolean,
): boolean {
  const sessionId = row.envelope.groupId;
  if (!hasSession(sessionId)) return true;
  return Boolean(row.conversation.closed?.closed_at?.trim()) && !isSessionClosed(sessionId);
}

export function subscribeCloudGroupCatalog({
  accountId,
  hasSession,
  isSessionClosed = () => false,
  rememberConversations,
  applyRow,
  reportError,
}: {
  accountId: string;
  hasSession: (sessionId: string) => boolean;
  /** Whether a session already shows as closed here; a newly closed one is applied again. */
  isSessionClosed?: (sessionId: string) => boolean;
  rememberConversations: (conversations: ChatSyncConversation[]) => void;
  applyRow: (row: NonNullable<ReturnType<typeof cloudGroupCatalogRow>>) => Promise<void>;
  reportError: (error: unknown) => void;
}): () => void {
  let active = true;
  let pending = Promise.resolve();
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<CatalogDetail>).detail;
    if (detail.accountId !== accountId) return;
    rememberConversations(detail.conversations);
    // Serialize batches so duplicate snapshots cannot race session creation.
    pending = pending.then(async () => {
      for (const conversation of detail.conversations) {
        if (!active) return;
        const row = cloudGroupCatalogRow(conversation, accountId);
        if (!row || !cloudGroupCatalogRowNeedsApply(row, hasSession, isSessionClosed)) continue;
        try {
          await applyRow(row);
        } catch (error) {
          if (active) reportError(error);
        }
      }
    });
  };
  window.addEventListener(CLOUD_GROUP_CATALOG_SYNC_EVENT, listener);
  return () => {
    active = false;
    window.removeEventListener(CLOUD_GROUP_CATALOG_SYNC_EVENT, listener);
  };
}
