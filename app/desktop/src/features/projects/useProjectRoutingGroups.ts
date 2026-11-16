import { useMemo, useState } from 'react';
import {
  buildProjectRoutingGroups,
  rememberProjectMembership,
} from '@/features/canonical/sessionResolver';
import type { CanonicalSessionState, DesktopChatState } from '@/kordi-app/types';
import { isNativeDesktopShell } from '@/lib/desktop';
import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import { localProjectSessionHints } from './localProjectSessions';
import { useRemoteProjectCatalog } from './remoteProjectCatalog';

function sameMembership(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>) {
  if (left.size !== right.size) return false;
  for (const [sessionId, groupId] of left) {
    if (right.get(sessionId) !== groupId) return false;
  }
  return true;
}

/**
 * Project groups for the sidebar and project views. A session whose project is
 * already known stays in its group while the runtime catalog catches up.
 */
export function useProjectRoutingGroups(
  desktopChatState: DesktopChatState | null | undefined,
  canonicalSessionState: CanonicalSessionState | null | undefined,
) {
  const [membership, setMembership] = useState<ReadonlyMap<string, string>>(() => new Map());
  const hints = useMemo(
    () => (desktopChatState ? localProjectSessionHints(desktopChatState, canonicalSessionState) : null),
    [canonicalSessionState, desktopChatState],
  );
  const localRoots = useMemo(() => (desktopChatState?.projects ?? []).map((project) => project.root), [desktopChatState?.projects]);
  // Folders this profile already works in help find a synced project's folder.
  const folderHints = useMemo(() => [desktopChatState?.cwd ?? '', desktopChatState?.activeSession.cwd ?? ''], [desktopChatState?.cwd, desktopChatState?.activeSession.cwd]);
  // The web app has no project folders; it lists the projects the account's Macs publish.
  const browser = isBrowserAppRuntime();
  const remoteProjects = useRemoteProjectCatalog(browser || (Boolean(desktopChatState) && isNativeDesktopShell()), localRoots, folderHints);
  const groups = useMemo(() => buildProjectRoutingGroups(desktopChatState?.projects, canonicalSessionState, {
    sessionHints: hints?.sessionHints,
    unboundSessionIds: hints?.unboundSessionIds,
    previousGroupIdBySession: membership,
    remoteProjects,
    listEmptyRemoteProjects: browser,
  }), [browser, canonicalSessionState, desktopChatState?.projects, hints, membership, remoteProjects]);
  const nextMembership = useMemo(
    () => rememberProjectMembership(membership, groups, hints?.unboundSessionIds),
    [groups, hints, membership],
  );
  if (!sameMembership(nextMembership, membership)) setMembership(nextMembership);
  const sessionSummaryById = useMemo(
    () => new Map((hints?.sessionSummaries ?? []).map((session) => [session.id, session])),
    [hints],
  );
  return useMemo(() => ({ groups, sessionSummaryById }), [groups, sessionSummaryById]);
}
