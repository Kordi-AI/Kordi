import { CommonGroundError, commonGroundErrorMessage } from './client';
import {
  BUILD_POLL_MS, LOBBY_FALLBACK_POLL_MS, LOBBY_POLL_MS, MATCH_FALLBACK_POLL_MS, MATCH_POLL_MS, personKey, roomClosed,
  type CgScreen, type CgState, type CommonGroundStore,
} from './store';
import * as autoOps from './storeAutoRebuild';
import * as hintOps from './storeHints';
import type { CgRoomSummary } from './types';

function filterCaches(state: CgState, fields: Array<'rooms' | 'results' | 'matches' | 'people'>, keep: (id: string) => boolean): Partial<CgState> {
  return Object.fromEntries(fields.map((field) => {
    const cache = { ...state[field] };
    for (const id in cache) if (!keep(id)) delete cache[id];
    return [field, cache];
  }));
}

/** The authoritative room list also removes snapshots for memberships withdrawn elsewhere. */
export function reconcileRooms(store: CommonGroundStore, roomList: CgRoomSummary[]) {
  const codes = new Set(roomList.map((room) => room.code));
  store.set({ roomList, ...filterCaches(store.getSnapshot(), ['rooms', 'results'], (code) => codes.has(code)) });
}

/**
 * Fetches what `screen` shows and stores it. False when the result was set aside because other
 * state changed while it was out (its patch is built on the state it started from), so a caller
 * that needs it can ask again; true otherwise, including after an error.
 */
export async function refreshScreen(store: CommonGroundStore, screen: CgScreen): Promise<boolean> {
  const snapshot = store.getSnapshot;
  const before = snapshot();
  const patch: Partial<CgState> = {};
  const cache = <K extends 'rooms' | 'results' | 'matches' | 'people'>(key: K, id: string, value: CgState[K][string]) => {
    patch[key] = { ...before[key], [id]: value };
  };
  try {
    switch (screen.name) {
      case 'home': await store.loadHome(); return true;
      case 'lobby': {
        const room = await store.client.room(screen.code);
        cache('rooms', screen.code, room);
        // Someone found common ground: every lobby moves on to Results.
        if (room.matchingStarted && snapshot() === before && store.top() === screen) {
          store.set(patch);
          store.replace({ name: 'results', code: screen.code });
          return true;
        }
        break;
      }
      case 'results': {
        const room = store.client.room(screen.code).catch(() => null);
        cache('results', screen.code, await store.client.results(screen.code));
        const loaded = await room;
        if (loaded) cache('rooms', screen.code, loaded);
        break;
      }
      case 'match':
      case 'person': {
        const { accountId, profileId } = screen;
        cache(screen.name === 'match' ? 'matches' : 'people', personKey(accountId, profileId),
          await store.client[screen.name](accountId, profileId));
        break;
      }
      default: return true;
    }
    if (snapshot() !== before) return false;
    store.set(patch);
    return true;
  } catch (error) {
    const state = snapshot();
    // A fresh denial invalidates loaded content; transient errors preserve it for retry.
    if (error instanceof CommonGroundError && [403, 404].includes(error.status) && !error.routeMissing) {
      if ('code' in screen) {
        store.set({ ...filterCaches(state, ['rooms', 'results'], (code) => code !== screen.code),
          roomList: state.roomList.filter((room) => room.code !== screen.code) });
        if (store.top() === screen) store.home();
      } else if (screen.name === 'match' || screen.name === 'person') {
        const key = personKey(screen.accountId, screen.profileId);
        store.set(filterCaches(state, ['matches', 'people'], (id) => id !== key));
      }
    } else if (state !== before) return true;
    store.set({ notice: commonGroundErrorMessage(error) });
    return true;
  }
}

/** The lobby or matching poll delay: today's pace until a room or match hint shows the stream works. */
function pollDelay(store: CommonGroundStore, screen: CgScreen): number {
  const heard = hintOps.roomHintsHeard(store);
  if (screen.name === 'lobby') return heard ? LOBBY_FALLBACK_POLL_MS : LOBBY_POLL_MS;
  return heard ? MATCH_FALLBACK_POLL_MS : MATCH_POLL_MS;
}

/** The store's `poll()`: refreshes what the top screen waits on; returns the next delay or null. */
export async function pollTop(store: CommonGroundStore): Promise<number | null> {
  // Polls run while the window shows: hints held back while it was hidden run now.
  void hintOps.flushRoomHints(store);
  const state = store.getSnapshot;
  const screen = store.top();
  try {
    if (state().owner?.build.status === 'building') {
      const profileId = state().profileId;
      const owner = await store.client.card(profileId);
      if (state().profileId === profileId) store.applyOwner(owner);
      return owner.build.status === 'building' ? BUILD_POLL_MS : null;
    }
    const matching = () => {
      const status = screen.name === 'results' ? state().results[screen.code]?.status
        : screen.name === 'match' ? state().matches[personKey(screen.accountId, screen.profileId)]?.status : 'ready';
      return !status || status === 'matching';
    };
    if (screen.name === 'lobby' || (matching() && (screen.name !== 'results' || !roomClosed(state(), screen.code)))) {
      await hintOps.refreshShared(store, screen);
      if (store.top() !== screen) return null;
      return screen.name === 'lobby' || matching() ? pollDelay(store, screen) : null;
    }
  } catch {
    return pollDelay(store, screen);
  }
  if (autoOps.cardRefreshDue(store)) return autoOps.refreshCard(store);
  await store.syncFromServer();
  return null;
}
