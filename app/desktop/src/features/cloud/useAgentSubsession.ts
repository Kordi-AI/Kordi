import { createContext, useEffect, useState } from 'react';
import { CloudAuthClient, CloudAuthError } from './authClient';
import { CLOUD_SESSION_CHANGED_EVENT, loadSession } from './session';
import type { CloudAgentSubsession } from './agentSubsessionTypes';
import { onSubsessionActivity } from './subsessionActivity';

export const AgentSubsessionNavigationContext = createContext<((id: string) => void) | null>(null);

export function useAgentSubsession(id: string | null, includeMessages = false) {
  const [snapshot, setSnapshot] = useState<CloudAgentSubsession | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [viewerAccountId, setViewerAccountId] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const changed = () => { setSnapshot(null); setError(null); setViewerAccountId(''); setRetry((value) => value + 1); };
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, changed);
    return () => window.removeEventListener(CLOUD_SESSION_CHANGED_EVENT, changed);
  }, []);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: CloudAgentSubsession | null = null;
    let accountId: string | null = null;
    let failures = 0;
    let emptySessionReads = 0;
    const client = new CloudAuthClient();
    // One pending poll at a time, also when a hint starts a read early.
    const schedule = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(() => { void load(); }, ms); };
    const load = async () => {
      try {
        const session = await loadSession();
        if (session && accountId && session.accountId !== accountId) { setSnapshot(null); setError({ id, message: 'Sign in to view this task.' }); return; }
        if (!session) {
          // One empty read can be a save in progress; keep looking.
          if (++emptySessionReads >= 3) { setSnapshot(null); current = null; setError({ id, message: 'Sign in to view this task.' }); }
          if (!cancelled) schedule(1500);
          return;
        }
        emptySessionReads = 0;
        accountId = session.accountId;
        let next = await client.getAgentSubsession(session.token, id, includeMessages && current == null);
        if (includeMessages && current && next.version !== current.version) next = await client.getAgentSubsession(session.token, id, true);
        if (cancelled || (await loadSession())?.accountId !== accountId) return;
        setViewerAccountId(accountId);
        if (current && next.version === current.version) next = { ...next, messages: current.messages };
        if (!current || next.version !== current.version || next.live !== current.live || next.queued !== current.queued || next.startedAtMs !== current.startedAtMs || next.agentDisplayName !== current.agentDisplayName || next.ownerDisplayName !== current.ownerDisplayName || next.agentAvatarUrl !== current.agentAvatarUrl || JSON.stringify(next.participants) !== JSON.stringify(current.participants)) { current = next; setSnapshot(next); }
        failures = 0;
        setError(null);
      } catch (failure) {
        if (cancelled) return;
        failures = failure instanceof CloudAuthError && [401, 403, 404].includes(failure.status ?? 0) ? 3 : failures + 1;
        if (failures >= 3) { setSnapshot(null); current = null; setError({ id, message: 'This task is not available. Check access or try again after synchronization.' }); }
      }
      if (!cancelled) schedule(includeMessages || current?.status === 'running' || current?.queued || !current ? 1500 : 10000);
    };
    void load();
    // A continue or a follow-up turn on this Mac: read the record now.
    const stopListening = onSubsessionActivity(id, () => {
      if (!cancelled) schedule(0);
    });
    return () => { cancelled = true; stopListening(); if (timer) clearTimeout(timer); };
  }, [id, includeMessages, retry]);
  return { snapshot: snapshot?.sessionId === id ? snapshot : null, accountId: viewerAccountId, error: error?.id === id ? error?.message ?? null : null, reload: () => { setError(null); setRetry((value) => value + 1); } };
}
