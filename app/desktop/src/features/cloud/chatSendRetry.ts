import { CloudAuthError, isRetryableCloudDeliveryError } from './cloudAuthError';

/**
 * Waits between attempts of one queued send, for direct and group messages
 * alike. Direct sends are scheduled by the desktop outbox in
 * `src-tauri/src/canonical_sessions/chat_sync/outbox.rs` (`record_outbox_failure`)
 * with this same list; the last wait repeats for as long as the send keeps
 * failing for a transient reason.
 */
export const CHAT_SEND_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000] as const;

/** The longest `Retry-After` honored; a larger value is treated as this. */
export const CHAT_SEND_RETRY_AFTER_MAX_MS = 5 * 60_000;

/** The wait after the given number of failed attempts (one or more). */
export function chatSendRetryDelayMs(failedAttempts: number): number {
  const index = Math.min(Math.max(1, Math.floor(failedAttempts)) - 1, CHAT_SEND_RETRY_DELAYS_MS.length - 1);
  return CHAT_SEND_RETRY_DELAYS_MS[Number.isFinite(index) ? index : 0];
}

/**
 * A failure that says nothing about whether the server stored the message: no
 * response (offline, timed out, connection lost), a rate limit, an expired
 * session or a server error. The send stays queued and is repeated with the
 * same client message id, which the server deduplicates.
 */
export function isTransientChatSendError(error: unknown): boolean {
  return error instanceof CloudAuthError && isRetryableCloudDeliveryError(error);
}

const QUEUED_FOR_RETRY = Symbol('kordi.chatSendQueuedForRetry');

/** Marks a send failure whose message stays in the outbox and is sent again in the background. */
export function markChatSendQueuedForRetry(error: unknown): void {
  if (error && typeof error === 'object') {
    Object.defineProperty(error, QUEUED_FOR_RETRY, { value: true, configurable: true });
  }
}

/** The send's outcome is unknown and the outbox keeps trying: show it as sending, not failed. */
export function chatSendQueuedForRetry(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { [QUEUED_FOR_RETRY]?: boolean })[QUEUED_FOR_RETRY]);
}

/** The wait a 429 or 503 asked for through `Retry-After`, capped; null when it named none. */
export function chatSendRetryAfterMs(error: unknown, maxMs = CHAT_SEND_RETRY_AFTER_MAX_MS): number | null {
  if (!(error instanceof CloudAuthError) || (error.status !== 429 && error.status !== 503)) return null;
  const seconds = error.retryAfterSeconds;
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(Math.ceil(seconds * 1_000), maxMs);
}

/** Holds background sends for an account until the server's `Retry-After` has passed. */
export function createChatSendRetryGate(now: () => number = () => Date.now()) {
  const holdUntilMs = new Map<string, number>();
  return {
    hold(key: string, waitMs: number) {
      const until = now() + Math.max(0, waitMs);
      holdUntilMs.set(key, Math.max(holdUntilMs.get(key) ?? 0, until));
    },
    remainingMs(key: string): number {
      const until = holdUntilMs.get(key);
      if (until === undefined) return 0;
      const remaining = until - now();
      if (remaining > 0) return remaining;
      holdUntilMs.delete(key);
      return 0;
    },
  };
}

export type ChatSendRetryGate = ReturnType<typeof createChatSendRetryGate>;

export const chatSendRetryGate = createChatSendRetryGate();
