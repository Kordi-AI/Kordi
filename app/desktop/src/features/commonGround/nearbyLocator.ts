// Grounding › Nearby location from this device, like the iPhone and foreground only. While the
// Nearby screen is open, Nearby is on and not paused, and the window is visible, the device sends a
// fix when the screen opens, when sharing turns on or resumes, on Refresh results, and every
// 5 minutes after that, never more than once a minute and one request at a time. A denied
// permission stops the automatic requests for the session; the manual action stays and retries.

import { commonGroundErrorMessage, type CommonGroundClient } from './client';
import type { CgNearbyPhase } from './nearbyFormat';
import { NearbyLocationError, nearbyLocationAvailable, requestNearbyDeviceLocation, type NearbyLocationInput } from './nearbyLocationFix';

/** The shortest gap between automatic requests. */
export const NEARBY_LOCATE_MIN_MS = 60_000;
/** How often the open screen sends a new fix, well inside the server's 30-minute window. */
export const NEARBY_LOCATE_EVERY_MS = 5 * 60_000;
const TICK_MS = 15_000;

export type NearbyLocatorState = {
  /** A request is running, automatic or manual. */
  busy: boolean;
  /** One quiet line: any manual failure, or the permission problem that stopped automatic requests. */
  notice: string | null;
  /** System Settings can fix the notice. */
  settings: boolean;
  /** Automatic requests stopped for the session until a manual request succeeds. */
  blocked: boolean;
};

export type NearbyLocatorEnv = {
  locate: () => Promise<NearbyLocationInput>;
  available: () => boolean;
  hidden: () => boolean;
  now: () => number;
};

/** The parts of the Nearby store the locator uses. */
export type NearbyLocatorHost = {
  readonly host: { readonly client: Pick<CommonGroundClient, 'postNearbyLocation'> };
  phase: (now?: number) => CgNearbyPhase;
  refresh: () => Promise<void>;
};

const browserEnv: NearbyLocatorEnv = {
  locate: requestNearbyDeviceLocation,
  available: nearbyLocationAvailable,
  hidden: () => typeof document !== 'undefined' && document.hidden,
  now: () => Date.now(),
};

export class NearbyLocator {
  private state: NearbyLocatorState = { busy: false, notice: null, settings: false, blocked: false };
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private screens = 0;
  private attemptedAt = -Infinity;
  env: NearbyLocatorEnv;

  constructor(private readonly nearby: NearbyLocatorHost, env: Partial<NearbyLocatorEnv> = {}) {
    this.env = { ...browserEnv, ...env };
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(patch: Partial<NearbyLocatorState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  /** The Nearby screen is open; a fix is posted only while one is. Returns the detach. */
  attach(): () => void {
    this.screens += 1;
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.screens -= 1;
    };
  }

  private sharing() {
    const phase = this.nearby.phase(this.env.now());
    return phase === 'on' || phase === 'no-phone';
  }

  /**
   * An automatic request. Skipped while one runs, within `gap` of the last attempt, without an open
   * screen, while hidden, off or paused, and after a denied permission.
   */
  auto(gap = NEARBY_LOCATE_MIN_MS): Promise<void> {
    if (this.running) return this.running;
    if (!this.screens || this.state.blocked || this.env.hidden() || !this.env.available() || !this.sharing()) return Promise.resolve();
    if (this.env.now() - this.attemptedAt < gap) return Promise.resolve();
    return this.run(false);
  }

  /** The person's own request: ignores the throttle and a previous denial. */
  locate(): Promise<void> {
    return this.running ?? this.run(true);
  }

  private run(manual: boolean): Promise<void> {
    this.attemptedAt = this.env.now();
    this.set(manual ? { busy: true, notice: null, settings: false } : { busy: true });
    this.running = (async () => {
      try {
        const fix = await this.env.locate();
        // Leaving the screen, sign-out, pausing, or turning Nearby off cancels publication of a late fix.
        if (!this.screens || !this.sharing()) return;
        await this.nearby.host.client.postNearbyLocation(fix);
        this.set({ notice: null, settings: false, blocked: false });
        if (this.screens) await this.nearby.refresh();
      } catch (error) {
        const blocked = error instanceof NearbyLocationError && error.blocked;
        // Automatic requests stay quiet unless they had to stop.
        if (manual || blocked) {
          this.set({
            notice: commonGroundErrorMessage(error),
            settings: error instanceof NearbyLocationError && error.settings,
            blocked: this.state.blocked || blocked,
          });
        }
      } finally {
        this.running = null;
        this.set({ busy: false });
      }
    })();
    return this.running;
  }
}

/** Asks for a new fix every few minutes while the screen stays open. Returns a stop function. */
export function startNearbyLocating(locator: NearbyLocator): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    await locator.auto(NEARBY_LOCATE_EVERY_MS);
    if (!stopped) timer = setTimeout(() => void tick(), TICK_MS);
  };
  timer = setTimeout(() => void tick(), TICK_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
