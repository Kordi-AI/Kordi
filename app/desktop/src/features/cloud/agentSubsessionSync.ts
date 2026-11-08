import { CloudAuthClient, CloudAuthError } from './authClient';
import { loadSession } from './session';
import { isTransientCloudFailure } from './cloudDesktopExecutionLease';
import { fetchDesktopSubsessionSnapshot } from '@/lib/desktopBackgroundSessions';
import { cancelDesktopChatTurn, renewDesktopChatExecutionLease } from '@/lib/desktop';
import { relatedAgentSessionsFromTools, normalizedRelatedAgentSessionStatus } from '@/features/chat/relatedAgentSessions';
import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';

const jobs = new Map<string, Promise<void>>();
class SubsessionSyncStop extends Error {}
const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** How long a background session runs on this Mac after the last renewal. */
export const SUBSESSION_LEASE_WINDOW_MS = 30_000;
/** Renewals while a cloud request is pending, so a slow server cannot starve the deadline. */
export const SUBSESSION_LEASE_HEARTBEAT_MS = 5_000;

/** No answer from the cloud: a timeout, a server error, or a failed local read. */
const unanswered = (error: unknown) => !(error instanceof CloudAuthError) || isTransientCloudFailure(error);

export async function publishModelSubsession(id: string): Promise<void> {
  const account = await loadSession();
  if (!account) throw new Error('Sign in to synchronize this task.');
  const key = `${account.accountId}:${id}`;
  const existing = jobs.get(key);
  if (existing) return existing;
  let resolveFirst!: () => void;
  let rejectFirst!: (error: unknown) => void;
  const first = new Promise<void>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  jobs.set(key, first);
  const client = new CloudAuthClient();
  void (async () => {
    let version: number | null = null;
    // The cloud refused this snapshot: keep the task running on this Mac and
    // stop publishing it, instead of letting the task's watchdog stop it.
    let publishRefused = false;
    let runningTurnId: string | null = null;
    // The deadline starts with the first accepted or refused publish. After
    // that, this loop keeps the task alive while it runs: a slow or
    // unreachable cloud must not stop a task that runs on this Mac. Only a
    // stop, a sign-out, refused attempts for the whole window, or this page
    // closing end it.
    let leaseArmed = false;
    let keepAlive = true;
    let watching = true;
    const renew = () => {
      if (!watching || !leaseArmed || !keepAlive || !runningTurnId) return Promise.resolve();
      return renewDesktopChatExecutionLease(runningTurnId, Date.now() + SUBSESSION_LEASE_WINDOW_MS).catch(() => undefined);
    };
    let heartbeatStarted = false;
    const heartbeat = () => {
      if (!watching) return;
      void renew();
      window.setTimeout(heartbeat, SUBSESSION_LEASE_HEARTBEAT_MS);
    };
    const armLease = () => {
      leaseArmed = true;
      if (heartbeatStarted) return;
      heartbeatStarted = true;
      window.setTimeout(heartbeat, SUBSESSION_LEASE_HEARTBEAT_MS);
    };
    try {
      for (;;) {
        let current: Awaited<ReturnType<typeof loadSession>>;
        try { current = await loadSession(); }
        catch {
          // Reading the stored sign-in failed once; that is not a sign-out.
          await renew();
          await pause(1500);
          continue;
        }
        if (!current || current.accountId !== account.accountId) throw new Error('Account changed.');
        try {
          const snapshot = await fetchDesktopSubsessionSnapshot(id);
          if (!snapshot.parentRequestId) throw new SubsessionSyncStop('This task has no shared request identity.');
          snapshot.status = normalizedRelatedAgentSessionStatus(snapshot.status);
          runningTurnId = snapshot.turnId && snapshot.status === 'running' ? snapshot.turnId : null;
          const afterRead = await loadSession();
          if (afterRead?.accountId !== account.accountId) throw new Error('Account changed.');
          if (!publishRefused) {
            if (version == null) {
              const record = await client.getAgentSubsession(current.token, id).catch((error) => {
                if (error instanceof CloudAuthError && error.status === 404) return null;
                throw error;
              });
              if ((await loadSession())?.accountId !== account.accountId) throw new Error('Account changed.');
              if (record?.status === 'stopped' && runningTurnId) {
                watching = false;
                await cancelDesktopChatTurn(runningTurnId);
                resolveFirst();
                return;
              }
              version = record?.version ?? 0;
            }
            const saved = await client.putAgentSubsession(current.token, snapshot, version);
            version = saved.version;
            resolveFirst();
            if (saved.status === 'stopped' && runningTurnId) {
              watching = false;
              await cancelDesktopChatTurn(runningTurnId);
              return;
            }
            if (saved.hasFollowupExecution) return;
          }
          keepAlive = true;
          armLease();
          if (!runningTurnId) return;
        } catch (error) {
          if (error instanceof SubsessionSyncStop || (error instanceof Error && error.message === 'Account changed.')) throw error;
          if (error instanceof CloudAuthError && [400, 403].includes(error.status ?? 0)) {
            publishRefused = true;
            resolveFirst();
            keepAlive = true;
            armLease();
          } else {
            // No answer (a native read that failed once, a timeout, a server
            // error) keeps the task alive and is retried. An answer that
            // refuses this attempt (an expired access token, a version
            // conflict) is retried without renewing. A lost response may
            // already have committed, so the version is reloaded; retries
            // never create or restart a model runtime.
            keepAlive = unanswered(error);
          }
          version = null;
        }
        await renew();
        await pause(1500);
      }
    } catch (error) { rejectFirst(error); }
    finally { watching = false; jobs.delete(key); }
  })();
  return first;
}

export async function publishModelSubsessions(turn: Pick<DesktopChatTurnSnapshot, 'tools'>): Promise<void> {
  await Promise.all(relatedAgentSessionsFromTools(turn.tools).map((session) => publishModelSubsession(session.sessionId)));
}
