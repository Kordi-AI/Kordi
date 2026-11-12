// One reconnect policy for every realtime socket: exponential backoff with
// full jitter, and an attempt count that survives a socket the server closes
// right after the handshake.

export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 60_000;
/** A socket has to stay open this long before the attempt count starts over. */
export const RECONNECT_STABLE_OPEN_MS = 30_000;

/** The largest delay an attempt can wait: 1 s, 2 s, 4 s, ... capped at 60 s. */
export function reconnectDelayCeilingMs(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  // 2^6 already passes the cap; bounding the exponent avoids huge numbers.
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.min(safeAttempt, 16));
}

/** Full jitter: a uniform delay between zero and the attempt's ceiling. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const sample = random();
  const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 1;
  return Math.floor(unit * reconnectDelayCeilingMs(attempt));
}

export type ReconnectBackoff = {
  readonly attempt: number;
  /** The socket opened; the count starts over only if it stays open long enough. */
  opened(): void;
  /** The socket or the attempt ended. */
  closed(): void;
  /** The wait before the next attempt; each call counts one attempt. */
  nextDelayMs(): number;
};

export function createReconnectBackoff({
  now = () => Date.now(),
  random = Math.random,
}: { now?: () => number; random?: () => number } = {}): ReconnectBackoff {
  let attempt = 0;
  let openedAtMs: number | null = null;
  return {
    get attempt() { return attempt; },
    opened() { openedAtMs = now(); },
    closed() {
      if (openedAtMs !== null && now() - openedAtMs >= RECONNECT_STABLE_OPEN_MS) attempt = 0;
      openedAtMs = null;
    },
    nextDelayMs() {
      const delay = reconnectDelayMs(attempt, random);
      attempt += 1;
      return delay;
    },
  };
}
