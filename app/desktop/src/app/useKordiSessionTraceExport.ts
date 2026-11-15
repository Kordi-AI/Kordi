import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';

import { saveDesktopTextFileAs } from '@/features/chat/attachmentDesktopActions';
import { defaultCloudAuthClient, type CloudAccount } from '@/features/cloud/authClient';
import { cloudMessageDeletions } from '@/features/cloud/cloudMessageDeletions';
import { loadSession, type StoredSession } from '@/features/cloud/session';
import { collectSessionTrace, type CollectSessionTraceDeps } from '@/features/sessionExport/collectSessionTrace';
import type { CloudSessionTraceDeps } from '@/features/sessionExport/cloudSessionTrace';
import { serializeSessionTrace, sessionTraceFileName } from '@/features/sessionExport/serializeSessionTrace';
import { sessionTraceParticipants, sessionTraceSessionInfo } from '@/features/sessionExport/sessionTraceMetadata';
import type { CanonicalSessionState, Contact, Conversation, DesktopChatState } from '@/kordi-app/types';
import { fetchDesktopChatSessionDetail } from '@/lib/desktop';
import { fetchCanonicalSessionMessages } from '@/lib/desktopCanonicalHistory';
import { loadChatSyncConversations } from '@/lib/desktopChatSync';
import type { SessionActionTarget } from '@/pages/SessionActionOverlays';

import { isDesktopRuntimeSessionId } from './desktopRuntimeSessionMembership';
import { shouldUseCloudSessionAction } from './useKordiAppModelHelpers';

type UseKordiSessionTraceExportArgs = {
  account: CloudAccount | null;
  canonicalState: CanonicalSessionState | null;
  conversations: readonly Conversation[];
  contacts: readonly Contact[];
  desktopState: DesktopChatState | null;
  isNativeShell: boolean;
  setDesktopError: Dispatch<SetStateAction<string | null>>;
};

async function nativeAppVersion() {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return null;
  }
}

function cloudTraceDeps(account: CloudAccount, contacts: readonly Contact[]): CloudSessionTraceDeps {
  const client = defaultCloudAuthClient();
  let login: Promise<StoredSession> | null = null;
  const signedIn = () => login ??= loadSession().then((session) => {
    if (!session?.token || session.accountId !== account.accountId) throw new Error('Sign in to Kordi first.');
    return session;
  });
  return {
    account,
    contacts,
    deletedMessageIds: cloudMessageDeletions.ids(account.accountId),
    findConversation: async (sessionId) => (await loadChatSyncConversations(account.accountId)).find((row) => (
      (row.legacy_session_id ?? row.id) === sessionId
      && row.members.some((member) => member.account_id === account.accountId)
    )) ?? null,
    fetchPage: async (conversationId, beforeSequence, limit) => client.listChatConversationHistoryPage(
      (await signedIn()).token, conversationId, beforeSequence, limit,
    ),
  };
}

/** Collects a session's complete trace and saves it as one JSON Lines file. */
export function useKordiSessionTraceExport({
  account,
  canonicalState,
  conversations,
  contacts,
  desktopState,
  isNativeShell,
  setDesktopError,
}: UseKordiSessionTraceExportArgs) {
  const exporting = useRef(false);
  return useCallback(async (target: SessionActionTarget) => {
    const sessionId = target.sessionId.trim();
    if ((!isNativeShell && !isBrowserAppRuntime()) || !sessionId || exporting.current) return;
    exporting.current = true;
    setDesktopError(null);
    try {
      const canonicalSession = canonicalState?.sessions.find((session) => session.id === sessionId) ?? null;
      const conversation = conversations.find((item) => item.id === sessionId || item.canonicalSessionId === sessionId);
      const runtime = isNativeShell && isDesktopRuntimeSessionId(desktopState?.sessions, desktopState?.projects, sessionId);
      const deps: CollectSessionTraceDeps = {
        runtime: runtime ? { fetchDetail: fetchDesktopChatSessionDetail, metadata: canonicalSession?.metadata } : null,
        canonical: {
          state: canonicalState,
          fetchPage: (id, before, limit) => fetchCanonicalSessionMessages(id, null, limit, { before }),
        },
        cloud: account && (isBrowserAppRuntime() || shouldUseCloudSessionAction(sessionId, canonicalState))
          ? cloudTraceDeps(account, contacts)
          : null,
        localAgentLabel: desktopState?.localAgent?.label ?? null,
      };
      const trace = await collectSessionTrace(sessionId, deps);
      const exportedAt = new Date();
      const viewer = {
        exportedBy: account?.accountId ?? canonicalState?.profile.humanIdentityId ?? 'local',
        viewerIdentityId: canonicalState?.profile.humanIdentityId ?? null,
      };
      const contents = serializeSessionTrace({
        exportedAt,
        appVersion: isNativeShell ? await nativeAppVersion() : null,
        session: sessionTraceSessionInfo({
          sessionId, title: target.sessionName, canonicalSession, conversation, runtime,
        }),
        participants: sessionTraceParticipants(conversation, trace.messages, viewer),
        ...viewer,
        messages: trace.messages,
        complete: trace.complete,
      });
      await saveDesktopTextFileAs(sessionTraceFileName(target.sessionName, exportedAt), contents);
    } catch (error) {
      const reason = error instanceof Error ? error.message.trim() : '';
      setDesktopError(reason ? `Export failed: ${reason}` : 'Export failed');
    } finally {
      exporting.current = false;
    }
  }, [account, canonicalState, contacts, conversations, desktopState, isNativeShell, setDesktopError]);
}
