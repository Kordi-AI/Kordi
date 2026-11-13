import { CloudAuthClient, CloudAuthError } from './authClient';
import { loadSession } from './session';
import { isTransientCloudFailure } from './cloudDesktopExecutionLease';
import { fetchDesktopSubsessionSnapshot } from '@/lib/desktopBackgroundSessions';
import { cancelDesktopChatTurn, renewDesktopChatExecutionLease } from '@/lib/desktop';
import { notifySubsessionActivity } from './subsessionActivity';
import { relatedAgentSessionsFromTools, normalizedRelatedAgentSessionStatus } from '@/features/chat/relatedAgentSessions';
import type { SubsessionSyncRefusal, TurnStopReason } from '@/features/chat/backgroundStopReason';
import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';

const jobs = new Map<string, Promise<void>>();
class SubsessionSyncStop extends Error {}
const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** How long a background session runs on this Mac after the last renewal. */
export const SUBSESSION_LEASE_WINDOW_MS = 30_000;
/** Renewals while a cloud request is pending, so a slow server cannot starve the deadline. */
export const SUBSESSION_LEASE_HEARTBEAT_MS = 5_000;
/** The pause between publishes while the cloud accepts them. */
export const SUBSESSION_SYNC_STEP_MS = 1_500;
/** The longest pause between attempts the cloud keeps refusing. */
export const SUBSESSION_SYNC_MAX_BACKOFF_MS = 30_000;
/** Empty sign-in reads in a row that count as a sign-out. One empty read can be a storage race. */
export const SUBSESSION_SIGNED_OUT_READS = 3;
/** Refused attempts after which a finished task stops publishing its final state. */
export const SUBSESSION_FINAL_PUBLISH_ATTEMPTS = 6;

/**
 * What a failed attempt means. `unanswered`: no answer (a timeout, a server
 * error, a failed local read). `refused`: the cloud answered and refused this
 * attempt (an expired access token, a version conflict, a rejected body).
 * Neither stops the task; a refusal is retried with backoff after reloading
 * the version, and the task is shown as not synced meanwhile.
 */
export type SubsessionSyncFailure = { kind: 'unanswered' } | { kind: 'refused'; refusal: SubsessionSyncRefusal };

export function classifySubsessionSyncFailure(error: unknown): SubsessionSyncFailure {
  if (!(error instanceof CloudAuthError) || isTransientCloudFailure(error)) return { kind: 'unanswered' };
  return { kind: 'refused', refusal: { status: error.status, code: error.serverCode || error.code || 'unknown' } };
}

/** The pause before the next attempt after `refusals` refused attempts in a row. */
export function subsessionSyncDelayMs(refusals: number): number {
  if (refusals <= 1) return SUBSESSION_SYNC_STEP_MS;
  return Math.min(SUBSESSION_SYNC_MAX_BACKOFF_MS, SUBSESSION_SYNC_STEP_MS * 2 ** (refusals - 1));
}

/** Whether this Mac's copy of a background session matches the cloud's. */
export type SubsessionSyncState = { synced: boolean; refusal: SubsessionSyncRefusal | null };
const syncStates = new Map<string, SubsessionSyncState>();
const syncListeners = new Set<() => void>();
const SYNCED: SubsessionSyncState = { synced: true, refusal: null };

export function subsessionSyncState(sessionId: string): SubsessionSyncState {
  return syncStates.get(sessionId) ?? SYNCED;
}

export function subscribeSubsessionSyncState(listener: () => void): () => void {
  syncListeners.add(listener);
  return () => { syncListeners.delete(listener); };
}

function setSyncState(sessionId: string, refusal: SubsessionSyncRefusal | null) {
  const current = syncStates.get(sessionId);
  if (!refusal) {
    if (!current) return;
    syncStates.delete(sessionId);
  } else {
    if (current?.refusal?.status === refusal.status && current.refusal.code === refusal.code) return;
    syncStates.set(sessionId, { synced: false, refusal });
  }
  for (const listener of syncListeners) listener();
}

/**
 * Publishes a background session that runs on this Mac and keeps its turn's
 * execution lease renewed while it runs. The lease only ends the task when
 * nothing renews it (this page closed or stalled). The loop itself stops the
 * task only for an explicit Stop (from any device), a sign-out or account
 * change, or a follow-up that took the task over elsewhere, and names the
 * reason each time. A slow, unreachable or refusing cloud never stops it.
 */
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
    let runningTurnId: string | null = null;
    // The turn this loop keeps alive. Renewal starts once the cloud record is
    // known not to be stopped, or could not be read.
    let leaseTurnId: string | null = null;
    let refusal: SubsessionSyncRefusal | null = null;
    let refusals = 0;
    let emptySessionReads = 0;
    let publishedStatus: string | null = null;
    let unansweredStreak = 0;
    let watching = true;
    const renew = () => {
      if (!watching || !leaseTurnId || leaseTurnId !== runningTurnId) return Promise.resolve();
      return renewDesktopChatExecutionLease(leaseTurnId, Date.now() + SUBSESSION_LEASE_WINDOW_MS, refusal).catch(() => undefined);
    };
    let heartbeatStarted = false;
    const heartbeat = () => {
      if (!watching) return;
      void renew();
      window.setTimeout(heartbeat, SUBSESSION_LEASE_HEARTBEAT_MS);
    };
    const armLease = (turnId: string) => {
      leaseTurnId = turnId;
      if (heartbeatStarted) return;
      heartbeatStarted = true;
      window.setTimeout(heartbeat, SUBSESSION_LEASE_HEARTBEAT_MS);
    };
    // An intentional stop: cancel the turn with its reason and stop watching.
    const stopTask = async (reason: TurnStopReason) => {
      watching = false;
      const turnId = runningTurnId;
      if (!turnId) return;
      console.info(`[subsessions] stopping background session ${id}: ${reason.kind}`);
      await cancelDesktopChatTurn(turnId, reason).catch((error) => {
        console.warn(`[subsessions] could not stop background session ${id}`, error);
      });
    };
    try {
      for (;;) {
        let current: Awaited<ReturnType<typeof loadSession>>;
        try { current = await loadSession(); }
        catch {
          // Reading the stored sign-in failed once; that is not a sign-out.
          await renew();
          await pause(SUBSESSION_SYNC_STEP_MS);
          continue;
        }
        if (!current) {
          // A sign-out clears the stored sign-in for good; a save in progress
          // can read as empty once.
          emptySessionReads += 1;
          if (emptySessionReads >= SUBSESSION_SIGNED_OUT_READS) {
            await stopTask({ kind: 'signed_out' });
            throw new Error('Signed out.');
          }
          await renew();
          await pause(SUBSESSION_SYNC_STEP_MS);
          continue;
        }
        emptySessionReads = 0;
        if (current.accountId !== account.accountId) {
          await stopTask({ kind: 'account_changed' });
          throw new Error('Account changed.');
        }
        try {
          const snapshot = await fetchDesktopSubsessionSnapshot(id);
          if (!snapshot.parentRequestId) throw new SubsessionSyncStop('This task has no shared request identity.');
          snapshot.status = normalizedRelatedAgentSessionStatus(snapshot.status);
          runningTurnId = snapshot.turnId && snapshot.status === 'running' ? snapshot.turnId : null;
          if (version == null) {
            const record = await client.getAgentSubsession(current.token, id).catch((error) => {
              if (error instanceof CloudAuthError && error.status === 404) return null;
              throw error;
            });
            if (record?.status === 'stopped' && runningTurnId) {
              // Stopped from another device or by the cloud.
              await stopTask(record.stopReason ?? { kind: 'cloud' });
              resolveFirst();
              return;
            }
            version = record?.version ?? 0;
          }
          if (runningTurnId) armLease(runningTurnId);
          const saved = await client.putAgentSubsession(current.token, snapshot, version);
          version = saved.version;
          unansweredStreak = 0;
          if (saved.status !== publishedStatus) { publishedStatus = saved.status; notifySubsessionActivity(id); }
          if (refusal) console.info(`[subsessions] background session ${id} is synced again`);
          refusal = null;
          refusals = 0;
          setSyncState(id, null);
          resolveFirst();
          if (saved.status === 'stopped' && runningTurnId) {
            await stopTask(saved.stopReason ?? { kind: 'cloud' });
            return;
          }
          if (saved.hasFollowupExecution) {
            // A follow-up execution started; two runtimes never run one task.
            if (runningTurnId && runningTurnId === leaseTurnId) await stopTask({ kind: 'continued_elsewhere' });
            return;
          }
          if (!runningTurnId) return;
        } catch (error) {
          if (error instanceof SubsessionSyncStop) throw error;
          const failure = classifySubsessionSyncFailure(error);
          // A running task keeps running either way; its lease is renewed
          // below. The cloud record catches up once an attempt is accepted.
          if (runningTurnId) armLease(runningTurnId);
          if (failure.kind === 'unanswered') {
            if (unansweredStreak++ === 0) console.warn(`[subsessions] no answer for background session ${id}; retrying`, error);
          } else unansweredStreak = 0;
          if (failure.kind === 'refused') {
            // A conflict or an expired access token clears up on retry; any
            // other refusal settles a caller waiting for the first attempt.
            if (![401, 409].includes(failure.refusal.status)) resolveFirst();
            refusal = failure.refusal;
            refusals += 1;
            setSyncState(id, refusal);
            console.warn(`[subsessions] the cloud refused an update of background session ${id}: ${refusal.status} ${refusal.code}`);
            if (!runningTurnId && (refusal.code === 'subsession_is_terminal' || refusals >= SUBSESSION_FINAL_PUBLISH_ATTEMPTS)) {
              resolveFirst();
              return;
            }
          }
          // A refused or lost write may have raced another writer or already
          // committed, so the version is reloaded. Retries never create or
          // restart a model runtime.
          version = null;
        }
        await renew();
        await pause(subsessionSyncDelayMs(refusals));
      }
    } catch (error) { rejectFirst(error); }
    finally { watching = false; jobs.delete(key); }
  })();
  return first;
}

export async function publishModelSubsessions(turn: Pick<DesktopChatTurnSnapshot, 'tools'>): Promise<void> {
  await Promise.all(relatedAgentSessionsFromTools(turn.tools).map((session) => publishModelSubsession(session.sessionId)));
}
