// Room and match hints for the Grounding store (`roomHints` brings them from the sync stream).
// A room hint refreshes that room's Results and members, or the Rooms list on Home; a match hint
// refreshes Results or a match page. Refreshes of one screen run one at a time and are shared
// with the polling: a hint during a refresh asks for exactly one more after it, because the
// running request may predate the change, while a poll during one waits for it. A hint waits
// while a user action is in flight or the window is hidden, and runs once that clears (the next
// poll, when the window shows again). The first hint shows the stream delivers them, so the
// polling can fall back to a slower pace.

import type { CgRoomHints } from './roomHints';
import { refreshScreen } from './storeRefresh';
import type { CgScreen, CommonGroundStore } from './store';

/**
 * How many times a hint's refresh runs again when other state changed while it was out and its
 * result was set aside. The bound keeps a busy page from refetching forever; polling and the
 * next hint still follow.
 */
const MAX_SET_ASIDE = 3;

type Flight = {
  done: Promise<void>;
  /** Hints that arrived after the running request went out; they need one more run. */
  owed: CgRoomHints | null;
};

type HintState = {
  heard: boolean;
  /** Hints held back while an action runs or the window is hidden. */
  waiting: CgRoomHints | null;
  hidden: () => boolean;
  stopWaiting: (() => void) | null;
  /** Refreshes in flight, by screen or `ROOMS_LIST`. */
  flights: Map<object, Flight>;
};

const ROOMS_LIST = {};
const states = new WeakMap<CommonGroundStore, HintState>();

function stateOf(store: CommonGroundStore): HintState {
  let state = states.get(store);
  if (!state) {
    state = { heard: false, waiting: null, hidden: () => false, stopWaiting: null, flights: new Map() };
    states.set(store, state);
  }
  return state;
}

function merge(a: CgRoomHints | null, b: CgRoomHints | null): CgRoomHints | null {
  if (!a || !b) return a ?? b;
  return { codes: [...new Set([...a.codes, ...b.codes])], matches: a.matches || b.matches };
}

const blocked = (store: CommonGroundStore, state: HintState) => store.disposed || state.hidden() || Boolean(store.getSnapshot().busy);

/** Holds hints back; the action in flight finishing runs them, and so does the next poll. */
function hold(store: CommonGroundStore, state: HintState, hints: CgRoomHints) {
  state.waiting = merge(state.waiting, hints);
  if (store.disposed || state.stopWaiting || !store.getSnapshot().busy) return;
  state.stopWaiting = store.subscribe(() => {
    if (store.getSnapshot().busy) return;
    state.stopWaiting?.();
    state.stopWaiting = null;
    // Once the change that cleared `busy` has reached every listener.
    queueMicrotask(() => { void flushRoomHints(store); });
  });
}

/** True once a room or match hint arrived: the stream delivers them, and polling may slow down. */
export function roomHintsHeard(store: CommonGroundStore): boolean {
  return stateOf(store).heard;
}

/** Takes a batch of hints from the stream; resolves when the refresh it asked for has finished. */
export function receiveRoomHints(store: CommonGroundStore, hints: CgRoomHints, hidden: () => boolean = () => false): Promise<void> {
  const state = stateOf(store);
  state.heard = true;
  state.hidden = hidden;
  state.waiting = merge(state.waiting, hints);
  return flushRoomHints(store);
}

/** Runs the hints held back, unless an action still runs, the window is hidden or the page closed. */
export function flushRoomHints(store: CommonGroundStore): Promise<void> {
  const state = stateOf(store);
  const hints = state.waiting;
  if (!hints) return Promise.resolve();
  state.waiting = null;
  if (blocked(store, state)) {
    hold(store, state, hints);
    return Promise.resolve();
  }
  const screen = store.top();
  if (screen.name === 'home') {
    return hints.codes.length ? run(store, ROOMS_LIST, hints, async () => {
      if (store.top().name === 'home') await store.loadRooms();
      return true;
    }) : Promise.resolve();
  }
  const forRoom = screen.name === 'results' && hints.codes.includes(screen.code);
  const forMatches = hints.matches && (screen.name === 'results' || screen.name === 'match');
  return forRoom || forMatches ? run(store, screen, hints, () => refreshTop(store, screen)) : Promise.resolve();
}

/** Drops the hints held back, when the page closes: opening it again loads the screen anyway. */
export function clearRoomHints(store: CommonGroundStore) {
  const state = stateOf(store);
  state.waiting = null;
  state.stopWaiting?.();
  state.stopWaiting = null;
}

/** A refresh for the polling and the sync from other devices: joins one in flight instead of starting a second. */
export function refreshShared(store: CommonGroundStore, screen: CgScreen): Promise<void> {
  return run(store, screen, null, () => refreshTop(store, screen));
}

/** A screen no longer on top has nothing to refresh; its next opening loads it. */
const refreshTop = (store: CommonGroundStore, screen: CgScreen) => (store.top() === screen ? refreshScreen(store, screen) : Promise.resolve(true));

/**
 * Runs `work` for `key`, or joins the run in flight. Hints (`owed`) that join ask for exactly one
 * more run after it, however many arrive. A run whose result was set aside runs again for the
 * hints it served, a few times at most. A rerun that is due while an action runs or the window is
 * hidden goes back to waiting instead.
 */
function run(store: CommonGroundStore, key: object, owed: CgRoomHints | null, work: () => Promise<boolean>): Promise<void> {
  const state = stateOf(store);
  const running = state.flights.get(key);
  if (running) {
    running.owed = merge(running.owed, owed);
    return running.done;
  }
  const flight: Flight = { done: Promise.resolve(), owed };
  state.flights.set(key, flight);
  flight.done = (async () => {
    let setAside = 0;
    try {
      do {
        const serving = flight.owed;
        flight.owed = null;
        const landed = await work().catch(() => true);
        if (!landed && serving && setAside++ < MAX_SET_ASIDE) flight.owed = merge(flight.owed, serving);
        if (flight.owed && blocked(store, state)) {
          hold(store, state, flight.owed);
          return;
        }
      } while (flight.owed);
    } finally {
      state.flights.delete(key);
    }
  })();
  return flight.done;
}
