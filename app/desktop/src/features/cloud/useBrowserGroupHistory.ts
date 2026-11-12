import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { applyChatSyncLocalBatch, loadChatSyncConversations } from '@/lib/desktopChatSync';
import type { SessionHydrationState } from '@/features/canonical/canonicalStore';
import type { CanonicalMessagePage, CanonicalSessionMessage, Message } from '@/kordi-app/types';
import type { CloudAuthClient, CloudMessage } from './authClient';
import { cloudMessageAttachmentToMessageAttachment } from './cloudAttachments';
import { cloudMessageDeletions } from './cloudMessageDeletions';
import { cloudMessageMetadataOnly } from './cloudMessageCache';
import { parseCloudGroupControl, type CloudGroupControlEnvelope } from './cloudGroupMessages';
import { cloudMessageFromChatSync } from './chatSyncMapping';
import type { ChatSyncConversation, ChatSyncMessage } from './chatSyncTypes';
import { cachedSessionSnapshot, loadSession, type StoredSession } from './session';

const PAGE_SIZE = 50;
const PIN_CONTEXT_SIZE = 15;

export type ApplyBrowserGroupHistoryPage = (
  rows: readonly { wire: CloudMessage; envelope: CloudGroupControlEnvelope }[],
  session: StoredSession,
  shouldContinue: () => boolean,
  conversation: ChatSyncConversation,
) => Promise<CanonicalSessionMessage[]>;

export type BrowserGroupHistoryActions = {
  sessionId: string;
  error: 'latest' | 'older' | null;
  retry: () => void;
  page?: GroupPage;
  returnToLatest: () => void;
  loadPin?: (messageId: string, open?: boolean) => Promise<Message | null>;
};

type GroupPage = {
  beforeSequence: number | null;
  hasOlder: boolean;
  firstSequence: number | null;
  throughSequence?: number;
};

export function useBrowserGroupHistory({
  accountId, sessionId, ready, client, findConversation, applyPage, hydrate, onSettled,
}: {
  accountId: string | null;
  sessionId: string;
  ready: boolean;
  client: CloudAuthClient;
  findConversation: (sessionId: string) => ChatSyncConversation | undefined;
  applyPage: ApplyBrowserGroupHistoryPage;
  hydrate?: (sessionId: string, options?: { page?: Pick<CanonicalMessagePage, 'messages' | 'hasOlder'> }) => Promise<unknown>;
  onSettled?: (sessionId: string) => void;
}) {
  const scope = useMemo(() => ({ accountId, sessionId }), [accountId, sessionId]);
  const applyPageRef = useRef(applyPage);
  useLayoutEffect(() => { applyPageRef.current = applyPage; }, [applyPage]);
  const active = useRef<{ scope: typeof scope; controller: AbortController } | null>(null);
  const viewRevision = useRef(0);
  const flight = useRef<{ scope: typeof scope; task: Promise<void> } | null>(null);
  const [result, setResult] = useState<{ scope: typeof scope; page?: GroupPage; latest?: GroupPage; error: BrowserGroupHistoryActions['error'] } | null>(null);
  const current = result?.scope === scope ? result : null;
  const page = current?.page;
  const error = current?.error ?? null;

  const fetchPage = useCallback(async (before?: number, around?: string, limit = PAGE_SIZE, persist = true) => {
    const signal = active.current?.scope === scope ? active.current.controller.signal : null;
    if (!signal || signal.aborted || !accountId) return null;
    const session = await loadSession();
    if (!session || session.accountId !== accountId || signal.aborted) return null;
    const isCurrent = () => {
      const saved = cachedSessionSnapshot();
      return !signal.aborted && saved?.accountId === accountId
        && saved?.organizationId === session.organizationId;
    };
    const conversation = findConversation(sessionId)
      ?? (await loadChatSyncConversations(accountId)).find(row => (
        row.kind === 'group' && (row.legacy_session_id ?? row.id) === sessionId
      ));
    if (!conversation) throw new Error('This chat is unavailable.');
    if (!isCurrent()) return null;
    const response = await client.listChatConversationHistoryPage(
      session.token, conversation.id, before, limit, { signal, aroundMessageId: around },
    );
    if (!isCurrent()) return null;
    if (!around && response.hasMore && (!response.nextBeforeSequence
      || (before !== undefined && response.nextBeforeSequence >= before))) {
      throw new Error('Chat history did not advance its sequence cursor.');
    }
    const deleted = cloudMessageDeletions.ids(accountId);
    const rows = response.messages.filter(snapshot => !deleted.has(snapshot.id)).flatMap(snapshot => {
      const wire = cloudMessageMetadataOnly(cloudMessageFromChatSync(snapshot, conversation, accountId));
      const envelope = parseCloudGroupControl(wire.body);
      return envelope ? [{ wire, envelope, snapshot }] : [];
    });
    if (persist) {
      await applyChatSyncLocalBatch({
        accountId, expectedOrganizationId: session.organizationId ?? null, bootstrap: false,
        messages: response.messages,
      });
      if (!isCurrent()) return null;
      const messages = await applyPageRef.current([...rows].reverse(), session, isCurrent, conversation);
      if (!isCurrent()) return null;
      await hydrate?.(sessionId, { page: { messages, hasOlder: response.hasMore } });
    }
    return isCurrent() ? { rows, response } : null;
  }, [accountId, client, findConversation, hydrate, scope, sessionId]);

  const load = useCallback((before?: number) => {
    const selection = active.current;
    if (selection?.scope !== scope || selection.controller.signal.aborted) return Promise.resolve();
    if (flight.current?.scope === scope) return flight.current.task;
    const revision = viewRevision.current;
    const task = fetchPage(before).then(value => {
      if (!value || active.current !== selection || viewRevision.current !== revision) return;
      setResult(previous => {
        const current = previous?.scope === scope ? previous : null;
        const loaded = groupPage(value.response);
        const displayed = before !== undefined ? current?.page : undefined;
        const page = {
          ...loaded, throughSequence: displayed?.throughSequence,
          firstSequence: loaded.firstSequence ?? displayed?.firstSequence ?? null,
        };
        return { scope, page, latest: page.throughSequence === undefined ? page : current?.latest, error: null };
      });
      onSettled?.(sessionId);
    }).catch(() => {
      if (active.current !== selection || viewRevision.current !== revision) return;
      setResult(previous => ({
        scope, ...(previous?.scope === scope ? { page: previous.page, latest: previous.latest } : {}),
        error: before === undefined ? 'latest' : 'older',
      }));
      onSettled?.(sessionId);
    }).finally(() => {
      if (flight.current?.task === task) flight.current = null;
    });
    flight.current = { scope, task };
    return task;
  }, [fetchPage, onSettled, scope, sessionId]);

  useLayoutEffect(() => {
    if (!ready || !accountId || !sessionId) return;
    const selection = { scope, controller: new AbortController() };
    active.current = selection;
    void load();
    return () => {
      active.current = null;
      selection.controller.abort();
      if (flight.current?.scope === scope) flight.current = null;
    };
  }, [accountId, load, ready, scope, sessionId]);

  const loadOlderSessionMessages = useCallback((requestedId: string) => (
    requestedId === sessionId && page?.hasOlder && page.beforeSequence !== null && !error
      ? load(page.beforeSequence)
      : Promise.resolve()
  ), [error, load, page, sessionId]);
  const retry = useCallback(() => {
    void load(error === 'older' ? page?.beforeSequence ?? undefined : undefined);
  }, [error, load, page]);
  const returnToLatest = useCallback(() => {
    viewRevision.current++;
    if (current?.latest) setResult({ scope, page: current.latest, latest: current.latest, error: null });
    else {
      const pending = flight.current?.scope === scope ? flight.current.task : Promise.resolve();
      void pending.then(() => load());
    }
  }, [current?.latest, load, scope]);
  const loadPin = useCallback(async (messageId: string, open = false) => {
    if (open && flight.current?.scope === scope) await flight.current.task;
    const revision = open ? ++viewRevision.current : undefined;
    const data = await fetchPage(undefined, messageId, open ? PIN_CONTEXT_SIZE : 1, open);
    if (!data || (open && revision !== viewRevision.current)) return null;
    const row = data.rows.find(({ snapshot }) => pinMatches(snapshot, data.response.anchorMessageId ?? messageId));
    if (!row?.envelope.message) return null;
    const message = row.envelope.message;
    if (open) {
      const page = groupPage(data.response);
      const throughSequence = Math.max(...data.response.messages.map(snapshot => snapshot.conversation_sequence));
      setResult(previous => ({
        scope, page: { ...page, throughSequence },
        latest: previous?.scope === scope ? previous.latest : undefined, error: null,
      }));
    }
    return {
      id: messageId,
      entryId: message.id,
      reactionTargetMessageId: row.snapshot.id,
      role: message.senderAccountId === accountId ? 'user' : 'person',
      sender: message.senderDisplayName ?? row.envelope.actor.displayName,
      text: message.text,
      time: '',
      timestampMs: message.createdAtMs,
      attachments: row.wire.attachments?.map(cloudMessageAttachmentToMessageAttachment),
    } satisfies Message;
  }, [accountId, fetchPage, scope]);
  const actions = useMemo<BrowserGroupHistoryActions | undefined>(() => sessionId
    ? { sessionId, error, retry, page, returnToLatest, loadPin: ready ? loadPin : undefined }
    : undefined, [error, loadPin, page, ready, retry, returnToLatest, sessionId]);
  const hasOlderBySessionId = useMemo(() => sessionId
    ? { [sessionId]: Boolean(page?.hasOlder) }
    : {}, [page?.hasOlder, sessionId]);
  const hydration = page ? 'ready' : error ? 'error' : undefined;
  const hydrationBySessionId = useMemo<Readonly<Record<string, SessionHydrationState>>>(() => sessionId && hydration
    ? { [sessionId]: hydration }
    : {}, [hydration, sessionId]);
  return { actions, hasOlderBySessionId, hydrationBySessionId, loadOlderSessionMessages };
}

function pinMatches(snapshot: ChatSyncMessage, messageId: string) {
  return snapshot.id === messageId || snapshot.client_message_id === messageId;
}

function groupPage(response: { messages: readonly ChatSyncMessage[]; nextBeforeSequence: number | null; hasMore: boolean }): GroupPage {
  const first = response.messages[response.messages.length - 1];
  return { firstSequence: first?.conversation_sequence ?? null, beforeSequence: response.nextBeforeSequence, hasOlder: response.hasMore };
}
