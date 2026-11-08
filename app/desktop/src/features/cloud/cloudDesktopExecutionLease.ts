import type { CloudAgentRunClaimInput, CloudAuthClient, CloudMessage, SendCloudMessageOptions } from './authClient';
import { cloudOperationUuid } from './chatSyncMapping';
import { CloudAuthError } from './cloudAuthError';
import { cancelDesktopChatTurn, renewDesktopChatExecutionLease } from '@/lib/desktop';
import type { DesktopChatContextMessage } from '@/lib/desktop';
import { claimedProjectFromLease } from '@/features/projects/claimedProjectSession';

// A claim or renewal holds the run on the server for `leaseSeconds` from when
// the server handles it (45 s on servers that do not say). This Mac stops a
// margin earlier, counted from when the last accepted renewal was sent, so it
// always ends the turn before the server lease lapses and the run can move.
const DEFAULT_LEASE_SECONDS = 45;
const LEASE_MARGIN_MS = 5_000;
const MAX_LEASE_WINDOW_MS = 10 * 60_000;
/** How long this Mac may run without an accepted renewal when the server names no lease. */
export const DESKTOP_EXECUTION_WATCHDOG_MS = DEFAULT_LEASE_SECONDS * 1_000 - LEASE_MARGIN_MS;
const RENEW_INTERVAL_MS = 5_000;
// A slow server can take longer than the default request timeout to accept a
// renewal. Waiting for that answer, up to the deadline, keeps the turn alive
// instead of discarding a renewal the server accepted.
const RENEW_TIMEOUT_MAX_MS = 30_000;

/** The time this Mac may run after sending a claim or renewal that held the run for `leaseSeconds`. */
export function desktopExecutionLeaseWindowMs(leaseSeconds: unknown, fallbackMs = DESKTOP_EXECUTION_WATCHDOG_MS) {
  if (typeof leaseSeconds !== 'number' || !Number.isFinite(leaseSeconds) || leaseSeconds <= 0) return fallbackMs;
  return Math.min(MAX_LEASE_WINDOW_MS, Math.max(0, leaseSeconds * 1_000 - LEASE_MARGIN_MS));
}

/** Only the server's refusal ends a lease; a slow or failed request is retried. */
const leaseRefused = (error: unknown) => error instanceof CloudAuthError && [401, 403, 404, 409].includes(error.status);
/** A request that may succeed when sent again: no response, a timeout, or a server error. */
export const isTransientCloudFailure = (error: unknown) => error instanceof CloudAuthError
  && (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500);
const transientFailure = isTransientCloudFailure;
const ADMIT_RETRY_MS = 1_000;
// Mac first: while the owner's Mac is online the server holds the run for it
// (about 35 s), so a slow claim keeps retrying through that hold. The window
// stays inside the watchdog, which counts from the first attempt, and leaves
// time for the first renewal.
const CLAIM_RETRY_WINDOW_MS = 30_000;
const CLAIM_RETRY_MAX_DELAY_MS = 5_000;

/** `bindsProject`: this caller runs a project session in this Mac's folder of the project. */
export async function acquireDesktopExecutionLease(client: Pick<CloudAuthClient, 'desktopAgentExecution'>, token: string, input: CloudAgentRunClaimInput, options: { bindsProject?: boolean; claimRetryMs?: number; claimRetryWindowMs?: number } = {}) {
  const claimId = crypto.randomUUID();
  const started = Date.now();
  type ClaimResult = {runId: string; acquired: boolean; leaseSeconds?: number; contextSessionId?: string; turnIdentity?: Record<string, unknown>; connectorTools?: unknown[]; connectorAudience?: string; project?: unknown};
  const claimBody = { ...input, claimId, ...(options.bindsProject ? { bindsProject: true } : {}) };
  // A claim that timed out may still have reached the server. Resending it
  // with the same claim id is safe: the server answers with the lease it holds.
  // Only a refusal or the end of the window stops it; then the cloud answers.
  let result: ClaimResult;
  const retryWindowMs = options.claimRetryWindowMs ?? CLAIM_RETRY_WINDOW_MS;
  let retryDelayMs = options.claimRetryMs ?? ADMIT_RETRY_MS;
  for (;;) {
    try {
      result = await client.desktopAgentExecution<ClaimResult>(token, 'claim', claimBody);
      break;
    } catch (error) {
      if (!transientFailure(error) || Date.now() + retryDelayMs - started >= retryWindowMs) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    retryDelayMs = Math.min(retryDelayMs * 2, CLAIM_RETRY_MAX_DELAY_MS);
  }
  if (!result.acquired) return null;
  if (!result.turnIdentity || result.turnIdentity.ownerAccountId !== input.ownerAccountId
    || result.turnIdentity.requesterAccountId !== input.requesterAccountId) {
    throw new Error('The execution lease did not provide a matching runtime identity.');
  }
  const identityMessage: DesktopChatContextMessage = {
    id: `runtime-identity:${result.runId}`, authorName: 'Kordi runtime', authorKind: 'agent',
    contextRole: 'runtimeIdentity', text: JSON.stringify(result.turnIdentity),
    // Connector tool descriptors from the server; the native runtime registers them.
    executionLease: { runId: result.runId, claimId, ownerAccountId: input.ownerAccountId, sessionId: result.contextSessionId ?? input.sessionId,
      ...(Array.isArray(result.connectorTools) && result.connectorTools.length > 0 ? { connectorTools: result.connectorTools } : {}),
      ...(result.connectorAudience === 'owner_private' ? { connectorAudience: result.connectorAudience } : {}) },
  };
  let leaseWindowMs = desktopExecutionLeaseWindowMs(result.leaseSeconds);
  let deadline = started + leaseWindowMs;
  let turnId: string | null = null;
  let lost = false;
  let disposed = false;
  let renewing = false;
  // The requester or owner can stop the run from any device; renewals and
  // admission checks carry that request.
  let stopRequested = false;
  let onStop: (() => void) | null = null;
  const noteStop = (response: { cancelRequested?: boolean } | null | undefined) => {
    if (!response?.cancelRequested || stopRequested) return;
    stopRequested = true;
    onStop?.();
  };
  const loseLease = () => {
    lost = true;
    if (turnId) void cancelDesktopChatTurn(turnId).catch(() => undefined);
  };
  const timer = setInterval(() => {
    if (lost || disposed || renewing) return;
    if (deadline <= Date.now()) { loseLease(); return; }
    renewing = true;
    const sentAt = Date.now();
    const timeoutMs = Math.max(1_000, Math.min(RENEW_TIMEOUT_MAX_MS, deadline - sentAt));
    void client.desktopAgentExecution<{ cancelRequested?: boolean; leaseSeconds?: number }>(
      token, `${encodeURIComponent(result.runId)}/renew`, { claimId }, { timeoutMs },
    )
      .then(async (response) => {
        if (lost || disposed) return;
        noteStop(response);
        leaseWindowMs = desktopExecutionLeaseWindowMs(response?.leaseSeconds, leaseWindowMs);
        deadline = sentAt + leaseWindowMs;
        if (deadline <= Date.now()) throw new Error('Execution lease expired during renewal.');
        if (turnId) await renewDesktopChatExecutionLease(turnId, deadline).catch(loseLease);
      }, (error: unknown) => {
        // A transient failure keeps the turn running; the next tick retries
        // and the deadline above still bounds how long this Mac may continue.
        if (leaseRefused(error)) loseLease();
      }).catch(loseLease).finally(() => { renewing = false; });
  }, RENEW_INTERVAL_MS);
  return {
    runId: result.runId,
    claimId,
    /** The whole claim answer, for run kinds whose claim carries more fields. */
    claim: result as Readonly<Record<string, unknown>>,
    /** The project this run belongs to; the turn runs in this Mac's folder of it. */
    project: claimedProjectFromLease(result.project),
    contextMessages(messages: readonly DesktopChatContextMessage[]) {
      // Requester-dependent group policy now travels in the frozen turn identity,
      // never in the system header. Custom Agent definitions remain unchanged.
      return [...messages.filter(message => !message.id.startsWith('cloud-group-persona:')
        && !message.id.startsWith('requester:')), identityMessage];
    },
    /** Whether this Mac no longer owns the run, so it can no longer publish. */
    get lost() { return lost || deadline <= Date.now(); },
    get deadline() { if (lost || deadline <= Date.now()) throw new Error('Execution lease lost.'); return deadline; },
    attach(id: string) { turnId = id; if (lost || deadline <= Date.now()) loseLease(); },
    // Admission is idempotent, so one slow or failed request is sent again
    // while renewals keep the lease; only a refusal or the deadline ends it.
    async admitted() {
      for (;;) {
        if (lost || deadline <= Date.now()) { loseLease(); throw new Error('Execution lease lost.'); }
        try {
          const response = await client.desktopAgentExecution<{admitted:boolean; cancelRequested?: boolean}>(token, `${encodeURIComponent(result.runId)}/admit`, { claimId });
          noteStop(response);
          return response.admitted;
        } catch (error) {
          if (disposed || !transientFailure(error)) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, ADMIT_RETRY_MS));
      }
    },
    /** Runs `handler` once when a stop is requested, including one already noted. */
    onStopRequested(handler: () => void) { onStop = handler; if (stopRequested) handler(); },
    dispose() { disposed = true; clearInterval(timer); },
    async cancel() {
      if (lost || disposed) return;
      await client.desktopAgentExecution(token, `${encodeURIComponent(result.runId)}/cancel`, { claimId });
    },
    publisher: {
      sendMessage: async (_token: string, _peer: string, body: string, options: SendCloudMessageOptions = {}): Promise<CloudMessage> => {
        if (lost || deadline <= Date.now()) { loseLease(); throw new Error('Execution lease lost.'); }
        try {
          return await client.desktopAgentExecution<CloudMessage>(token, `${encodeURIComponent(result.runId)}/progress`, {
            claimId, body, clientMessageId: cloudOperationUuid(options.clientMessageId),
          });
        } catch (error) {
          // The server refuses a run this Mac no longer owns.
          if (error instanceof CloudAuthError && error.status === 409) loseLease();
          throw error;
        }
      },
    },
  };
}
