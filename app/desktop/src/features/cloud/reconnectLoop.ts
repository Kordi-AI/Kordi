import { createReconnectBackoff } from './reconnectPolicy';

/** One connection attempt. Calls from an attempt that is no longer current do nothing. */
export type ReconnectAttempt = {
  readonly current: boolean;
  /** The socket opened. */
  opened(): void;
  /** The socket closed or the attempt failed: wait, then try again. */
  closed(): void;
  /** Stop trying until the network returns or the window is shown again. */
  idle(): void;
};

export type ReconnectPhase = 'idle' | 'scheduled' | 'connecting' | 'open' | 'stopped';

type ListenerTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export type ReconnectLoopOptions = {
  connect: (attempt: ReconnectAttempt) => Promise<void> | void;
  /** A connect that throws counts as a closed attempt. */
  onError?: (error: unknown) => void;
  /** The network returned or the window was shown while the socket is open. */
  onResume?: () => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  /** Where `online` arrives; defaults to `window`. */
  networkTarget?: ListenerTarget | null;
  /** Where `visibilitychange` arrives; defaults to `document`. */
  visibilityTarget?: (ListenerTarget & { readonly visibilityState?: DocumentVisibilityState }) | null;
};

export type ReconnectLoop = {
  readonly phase: ReconnectPhase;
  start(): void;
  /** Connect now unless an attempt is in flight or a socket is open. */
  reconnectNow(): void;
  stop(): void;
};

// Resolved at call time so a window installed later (tests, late globals) is the one used.
const timerHost = (): Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> => (
  typeof window === 'undefined' ? globalThis : window
);
const defaultSetTimer = (callback: () => void, ms: number) => timerHost().setTimeout(callback, ms);
const defaultClearTimer = (timer: unknown) => timerHost().clearTimeout(timer as ReturnType<typeof setTimeout>);

export function createReconnectLoop(options: ReconnectLoopOptions): ReconnectLoop {
  const backoff = createReconnectBackoff({ now: options.now, random: options.random });
  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;
  const networkTarget = options.networkTarget !== undefined
    ? options.networkTarget
    : typeof window === 'undefined' ? null : window;
  const visibilityTarget = options.visibilityTarget !== undefined
    ? options.visibilityTarget
    : typeof document === 'undefined' ? null : document;
  let phase: ReconnectPhase = 'idle';
  let timer: unknown = null;
  let attemptId = 0;
  let started = false;

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const run = () => {
    if (phase === 'stopped') return;
    cancelTimer();
    phase = 'connecting';
    const id = ++attemptId;
    const isCurrent = () => id === attemptId && phase !== 'stopped';
    const attempt: ReconnectAttempt = {
      get current() { return isCurrent(); },
      opened() {
        if (!isCurrent() || phase !== 'connecting') return;
        phase = 'open';
        backoff.opened();
      },
      closed() {
        if (!isCurrent()) return;
        attemptId += 1;
        backoff.closed();
        phase = 'scheduled';
        timer = setTimer(() => { timer = null; run(); }, backoff.nextDelayMs());
      },
      idle() {
        if (!isCurrent()) return;
        attemptId += 1;
        backoff.closed();
        phase = 'idle';
      },
    };
    void Promise.resolve()
      .then(() => options.connect(attempt))
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        options.onError?.(error);
        attempt.closed();
      });
  };

  const reconnectNow = () => {
    if (phase === 'scheduled' || phase === 'idle') run();
    else if (phase === 'open') options.onResume?.();
  };
  const handleVisibility = () => {
    if (visibilityTarget?.visibilityState === 'visible') reconnectNow();
  };

  return {
    get phase() { return phase; },
    start() {
      if (started || phase === 'stopped') return;
      started = true;
      networkTarget?.addEventListener('online', reconnectNow);
      visibilityTarget?.addEventListener('visibilitychange', handleVisibility);
      run();
    },
    reconnectNow,
    stop() {
      if (phase === 'stopped') return;
      phase = 'stopped';
      attemptId += 1;
      cancelTimer();
      networkTarget?.removeEventListener('online', reconnectNow);
      visibilityTarget?.removeEventListener('visibilitychange', handleVisibility);
    },
  };
}
