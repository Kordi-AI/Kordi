import { useCallback } from 'react';

import {
  canonicalStateWithClosedSessions,
  closedGroupScope,
  metadataWithClosedAt,
} from '@/features/chat/closedGroup';
import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import type { CanonicalSessionState } from '@/kordi-app/types';
import { deleteDesktopChatSessionForever, updateCanonicalSessionMetadata } from '@/lib/desktop';

type ClosedGroupSessionActionsArgs = {
  canonicalState: CanonicalSessionState | null;
  setCanonicalState: (
    update: (current: CanonicalSessionState | null) => CanonicalSessionState | null,
  ) => void;
  refreshCanonicalState: () => Promise<unknown>;
  optimisticallyRemoveSession: (sessionId: string) => void;
  setDesktopError: (error: string | null) => void;
};

async function signedInToken() {
  const login = await loadSession();
  if (!login?.token) throw new Error('Sign in to Kordi first.');
  return login.token;
}

/**
 * Closing a group or channel, and Delete chat on a closed group
 * (docs/development/group-closed-state.md).
 */
export function useClosedGroupSessionActions({
  canonicalState,
  setCanonicalState,
  refreshCanonicalState,
  optimisticallyRemoveSession,
  setDesktopError,
}: ClosedGroupSessionActionsArgs) {
  // Delete chat on a closed group leaves it, which is how it leaves the list.
  // Returns false for anything else (an open chat, or a closed channel of an
  // open group), which the caller deletes like any other chat.
  const leaveClosedGroup = useCallback(async (sessionId: string) => {
    const scope = closedGroupScope(canonicalState, sessionId);
    if (!scope.groupClosed) return false;
    try {
      setDesktopError(null);
      await defaultCloudAuthClient().leaveGroup(await signedInToken(), scope.groupSpaceId);
      // The server already let go of these chats: remove them here for good.
      for (const groupSessionId of scope.groupSessionIds) {
        optimisticallyRemoveSession(groupSessionId);
        await deleteDesktopChatSessionForever(groupSessionId).catch(() => undefined);
      }
      await refreshCanonicalState();
    } catch (error) {
      setDesktopError(error instanceof Error ? error.message : 'Unable to remove chat');
      throw error;
    }
    return true;
  }, [canonicalState, optimisticallyRemoveSession, refreshCanonicalState, setDesktopError]);

  // Closing keeps the group (or channel) for everyone, the closer included.
  // The server tells every member's devices; this device marks it closed right away.
  const markSessionsClosed = useCallback(async (sessionIds: string[]) => {
    const closedAt = new Date().toISOString();
    setCanonicalState((current) => canonicalStateWithClosedSessions(current, sessionIds, closedAt));
    const requestedByIdentityId = canonicalState?.profile.humanIdentityId?.trim() || null;
    for (const sessionId of sessionIds) {
      const session = canonicalState?.sessions.find((candidate) => candidate.id === sessionId);
      if (!session) continue;
      await updateCanonicalSessionMetadata({
        sessionId,
        requestedByIdentityId,
        metadata: metadataWithClosedAt(session.metadata, closedAt),
      }).catch(() => undefined);
    }
    await refreshCanonicalState();
    // The server's own update follows; keep the row closed until it lands.
    setCanonicalState((current) => canonicalStateWithClosedSessions(current, sessionIds, closedAt));
  }, [canonicalState, refreshCanonicalState, setCanonicalState]);

  const dissolveGroup = useCallback(async (groupSpaceId: string, sessionIds: string[]) => {
    await defaultCloudAuthClient().dissolveGroup(await signedInToken(), groupSpaceId);
    await markSessionsClosed(sessionIds);
  }, [markSessionsClosed]);

  const dissolveChannel = useCallback(async (groupSpaceId: string, sessionId: string) => {
    await defaultCloudAuthClient().dissolveGroupChannel(await signedInToken(), groupSpaceId, sessionId);
    await markSessionsClosed([sessionId]);
  }, [markSessionsClosed]);

  return { leaveClosedGroup, dissolveGroup, dissolveChannel };
}
