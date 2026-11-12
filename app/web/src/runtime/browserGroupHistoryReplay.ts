import { browserCanonicalCloudMessageId } from './browserCanonicalProjection';
import { runBrowserCanonicalReplay } from './browserCanonicalStorage';
import type { CanonicalSessionState } from '@/kordi-app/types';
import type { CloudMessage } from '@/features/cloud/authClient';
import type { ChatSyncConversation } from '@/features/cloud/chatSyncTypes';
import type { CloudGroupControlEnvelope } from '@/features/cloud/cloudGroupMessages';
import { browserGroupCanonicalPersistence, type CloudGroupCanonicalPersistence } from '@/features/cloud/cloudGroupCanonicalPersistence';
import type { CanonicalSessionStateUpdate, CloudGroupCanonicalRuntime, CloudGroupSessionPreparationCache } from '@/features/cloud/cloudGroupControlContext';
import { cachedSessionSnapshot, type StoredSession } from '@/features/cloud/session';

export type BrowserGroupHistoryReplay = {
  persistence: CloudGroupCanonicalPersistence;
  canonical: CloudGroupCanonicalRuntime;
  preparations: CloudGroupSessionPreparationCache;
};

export type BrowserGroupHistoryApply = (
  wire: CloudMessage,
  envelope: CloudGroupControlEnvelope,
  options: {
    historyReplay: true;
    replay: BrowserGroupHistoryReplay;
    catalogGroupTitle?: string | null;
    catalogGroupAvatar?: CloudGroupControlEnvelope['groupAvatar'];
    catalogGroupOrigin?: string | null;
  },
) => Promise<void>;

export function replayBrowserGroupHistory(
  rows: readonly { wire: CloudMessage; envelope: CloudGroupControlEnvelope }[],
  session: StoredSession,
  shouldContinue: () => boolean,
  conversation: ChatSyncConversation,
  apply: BrowserGroupHistoryApply,
) {
  const isCurrent = () => {
    const current = cachedSessionSnapshot();
    return shouldContinue() && current?.accountId === session.accountId
      && current?.organizationId === session.organizationId;
  };
  const sessionId = rows[0]?.envelope.groupId;
  if (!sessionId) return Promise.resolve(undefined);
  const wireIds = new Set(rows.map(row => row.wire.messageId));
  const ids = new Set(rows.map(row => row.envelope.message?.id));
  return runBrowserCanonicalReplay(session.accountId, session.organizationId, sessionId, isCurrent, async (state, invoke) => {
    const persistence = browserGroupCanonicalPersistence(<T>(command: string, args: Record<string, unknown>) => Promise.resolve(invoke(command, args) as T));
    const preparations: CloudGroupSessionPreparationCache = new Map();
    const updates: CanonicalSessionStateUpdate[] = [];
    let projected: CanonicalSessionState | null = { ...state };
    const canonical: CloudGroupCanonicalRuntime = {
      getState: () => projected,
      setState: update => {
        projected = update(projected);
        updates.push(update);
      },
    };
    for (const { wire, envelope } of rows) {
      if (!isCurrent()) break;
      const createSession = !projected?.sessions.some(row => row.id === envelope.groupId);
      await apply(wire, envelope, {
        historyReplay: true, replay: { persistence, canonical, preparations },
        ...(createSession ? {
          catalogGroupTitle: conversation.group_title ?? conversation.shared_title,
          catalogGroupAvatar: conversation.group_avatar,
          catalogGroupOrigin: conversation.origin,
        } : {}),
      });
    }
    const messages = state.messages.filter(row => ids.has(row.id) || wireIds.has(browserCanonicalCloudMessageId(row) ?? ''));
    return { updates, messages };
  });
}
