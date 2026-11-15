import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';

import { isDesktopRuntimeSessionId } from '@/app/desktopRuntimeSessionMembership';
import { shouldUseCloudSessionAction } from '@/app/useKordiAppModelHelpers';
import { saveDesktopTextFileAs } from '@/features/chat/attachmentDesktopActions';
import { defaultCloudAuthClient, type CloudAccount, type CloudAuthClient } from '@/features/cloud/authClient';
import { cloudMessageDeletions } from '@/features/cloud/cloudMessageDeletions';
import { loadSession, type StoredSession } from '@/features/cloud/session';
import type { CanonicalSessionState, Contact, Conversation, DesktopChatState } from '@/kordi-app/types';
import { fetchDesktopChatSessionDetail } from '@/lib/desktop';
import { fetchDesktopSubsessionIds, fetchDesktopSubsessionSnapshot } from '@/lib/desktopBackgroundSessions';
import { fetchCanonicalSessionMessages } from '@/lib/desktopCanonicalHistory';
import { loadChatSyncConversations } from '@/lib/desktopChatSync';

import { collectSessionTrace, type CollectSessionTraceDeps } from './collectSessionTrace';
import type { CloudSessionTraceDeps } from './cloudSessionTrace';
import type { SubsessionTraceDeps } from './collectSubsessionTraces';
import { serializeSessionTrace, sessionTraceFileName } from './serializeSessionTrace';
import { sessionTraceParticipants, sessionTraceSessionInfo } from './sessionTraceMetadata';

export type SessionTraceExportContext = {
  account: CloudAccount | null;
  canonicalState: CanonicalSessionState | null;
  conversations: readonly Conversation[];
  contacts: readonly Contact[];
  desktopState: DesktopChatState | null;
  isNativeShell: boolean;
};

async function nativeAppVersion() {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return null;
  }
}

/** The viewer's stored sign-in, read once per export. */
function signedInSession(account: CloudAccount) {
  let login: Promise<StoredSession> | null = null;
  return () => login ??= loadSession().then((session) => {
    if (!session?.token || session.accountId !== account.accountId) throw new Error('Sign in to Kordi first.');
    return session;
  });
}

function cloudTraceDeps(
  account: CloudAccount,
  contacts: readonly Contact[],
  client: CloudAuthClient,
  signedIn: () => Promise<StoredSession>,
): CloudSessionTraceDeps {
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

/** Background sessions read the way the app opens them: this Mac's runtime, then the cloud record. */
function subsessionTraceDeps(
  account: CloudAccount | null,
  isNativeShell: boolean,
  client: CloudAuthClient,
  signedIn: (() => Promise<StoredSession>) | null,
): SubsessionTraceDeps {
  return {
    native: isNativeShell ? {
      listIds: fetchDesktopSubsessionIds,
      snapshot: fetchDesktopSubsessionSnapshot,
      fetchDetail: fetchDesktopChatSessionDetail,
    } : null,
    cloud: account && signedIn ? {
      accountId: account.accountId,
      listTasks: async (parentSessionId, after) => client.listAgentSubsessionTasks((await signedIn()).token, parentSessionId, after),
      read: async (sessionId) => client.getAgentSubsession((await signedIn()).token, sessionId, true),
    } : null,
  };
}

/** Collects a session's complete trace, with its background sessions, and saves it as one JSON Lines file. */
export async function exportSessionTrace(
  target: { sessionId: string; sessionName: string },
  { account, canonicalState, conversations, contacts, desktopState, isNativeShell }: SessionTraceExportContext,
) {
  const sessionId = target.sessionId.trim();
  const canonicalSession = canonicalState?.sessions.find((session) => session.id === sessionId) ?? null;
  const conversation = conversations.find((item) => item.id === sessionId || item.canonicalSessionId === sessionId);
  const runtime = isNativeShell && isDesktopRuntimeSessionId(desktopState?.sessions, desktopState?.projects, sessionId);
  const client = defaultCloudAuthClient();
  const signedIn = account ? signedInSession(account) : null;
  const deps: CollectSessionTraceDeps = {
    runtime: runtime ? { fetchDetail: fetchDesktopChatSessionDetail, metadata: canonicalSession?.metadata } : null,
    canonical: {
      state: canonicalState,
      fetchPage: (id, before, limit) => fetchCanonicalSessionMessages(id, null, limit, { before }),
    },
    cloud: account && signedIn && (isBrowserAppRuntime() || shouldUseCloudSessionAction(sessionId, canonicalState))
      ? cloudTraceDeps(account, contacts, client, signedIn)
      : null,
    subsessions: subsessionTraceDeps(account, isNativeShell, client, signedIn),
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
    subsessions: trace.subsessions,
    complete: trace.complete,
  });
  await saveDesktopTextFileAs(sessionTraceFileName(target.sessionName, exportedAt), contents);
}
