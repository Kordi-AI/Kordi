import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import { applyChatSyncLocalBatch, loadChatSyncConversations, loadChatSyncCoverage } from '@/lib/desktopChatSync';
import type { CloudAuthClient } from './authClient';
import type { StoredSession } from './session';

// History coverage and canonical pruning scan durable message tables. Once a
// repair succeeds, an empty cursor poll cannot invalidate that result.
export function createCloudHistoryRepair() {
  let revision = 0;
  let repairedRevision = -1;
  let pending: Promise<void> | null = null;
  return {
    invalidate() { revision += 1; },
    run(repair: () => Promise<void>): Promise<void> | null {
      if (pending) return pending;
      if (repairedRevision === revision) return null;
      const startedRevision = revision;
      pending = Promise.resolve().then(repair).then(() => {
        repairedRevision = startedRevision;
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}

export async function hydrateCloudHistory({ session, client, accountId, isCurrent }: {
  session: StoredSession;
  client: CloudAuthClient;
  accountId: string;
  isCurrent: () => boolean;
}) {
  const [conversations, coverage] = await Promise.all([
    loadChatSyncConversations(accountId),
    loadChatSyncCoverage(accountId),
  ]);
  if (!isCurrent()) return;
  const coverageByConversation = new Map(coverage.map((value) => [value.conversationId, value]));
  for (const conversation of conversations) {
    if (!isCurrent()) return;
    if (conversation.latest_message_sequence <= 0) continue;
    // Group transcript paging is scoped to the selected channel on web.
    // Retain the unread suffix in the sync store for sidebar counts.
    const readThrough = isBrowserAppRuntime() && conversation.kind === 'group'
      ? conversation.members.find(member => member.account_id === accountId)?.last_read_sequence ?? 0
      : 0;
    if (readThrough >= conversation.latest_message_sequence) continue;
    const stored = coverageByConversation.get(conversation.id);
    const earliestSequence = stored?.earliestSequence;
    const hasLatest = stored?.latestSequence === conversation.latest_message_sequence;
    const hasContiguousSuffix = Boolean(
      hasLatest
      && earliestSequence
      && stored?.messageCount === stored.latestSequence - earliestSequence + 1,
    );
    if (hasContiguousSuffix && earliestSequence && earliestSequence <= readThrough + 1) continue;
    // A clean bootstrap contains a contiguous suffix ending at the current
    // head, so page from its first item. If the local projection itself has
    // a middle gap, re-read the whole conversation instead of trusting the
    // presence of sequence one.
    let beforeSequence = hasContiguousSuffix ? earliestSequence : undefined;
    while (true) {
      const page = await client.listChatConversationHistoryPage(
        session.token,
        conversation.id,
        beforeSequence,
      );
      if (!isCurrent()) return;
      await applyChatSyncLocalBatch({
        accountId,
        expectedOrganizationId: session.organizationId ?? null,
        bootstrap: false,
        messages: page.messages,
      });
      if (!page.hasMore) break;
      const next = page.nextBeforeSequence;
      if (!next || (beforeSequence !== undefined && next >= beforeSequence)) {
        throw new Error('Reliable chat history did not advance its sequence cursor.');
      }
      if (next <= readThrough + 1) break;
      beforeSequence = next;
    }
  }
}
