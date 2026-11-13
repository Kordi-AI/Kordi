import { useEffect, useState, useSyncExternalStore } from 'react';

import { cloudApiBaseUrl } from '@/features/cloud/cloudApiEnvironment';
import { CLOUD_SESSION_CHANGED_EVENT, CLOUD_SESSION_SIGNED_OUT_EVENT } from '@/features/cloud/session';
import { subscribeCardHints } from './cardHints';
import { createCommonGroundClient } from './client';
import { COMMON_GROUND_PAIR_LINK_EVENT, takePendingPairLink } from './pairLink';
import { localProfileMemory } from './profiles';
import { subscribeRoomHints } from './roomHints';
import { CommonGroundStore } from './store';
import { requestCardRefresh } from './storeAutoRebuild';
import { clearRoomHints, receiveRoomHints } from './storeHints';
import { redeemPairLink } from './storePairing';
import { startCommonGroundPolling } from './polling';

const stores = new Map<string, CommonGroundStore>();
let listening = false;

/** One store per server, account and route version; a session change drops them all. */
export function commonGroundStoreFor(accountId: string, profiles = false): CommonGroundStore {
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    const clear = () => {
      stores.forEach((store) => store.dispose());
      stores.clear();
    };
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, clear);
    window.addEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, clear);
  }
  const key = JSON.stringify([cloudApiBaseUrl(), accountId, profiles]);
  let store = stores.get(key);
  if (!store) {
    store = new CommonGroundStore(createCommonGroundClient(), { profiles, memory: localProfileMemory(accountId) });
    stores.set(key, store);
  }
  return store;
}

/**
 * Store state, with polling while mounted and the window is visible, a refetch when it becomes
 * visible again, a refetch of the cards when a card build lands (`common_ground.card.updated`),
 * and a refresh of the open room's Results, match page or Rooms list when a room or match changes
 * (`common_ground.room.updated`, `common_ground.matches.updated`).
 */
export function useCommonGround(store: CommonGroundStore) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    if (!store.getSnapshot().loaded) void store.loadHome();
    else if (store.top().name === 'home') void store.loadRooms();
    if (store.top().name !== 'home') void store.loadScreen();
    const stopHints = subscribeCardHints(() => { void requestCardRefresh(store); });
    const stopRoomHints = subscribeRoomHints((hints) => { void receiveRoomHints(store, hints, () => document.hidden); });
    const stopPolling = startCommonGroundPolling(() => store.poll(), {
      win: window, doc: document, schedule: setTimeout, cancel: clearTimeout,
    });
    return () => {
      stopHints();
      stopRoomHints();
      clearRoomHints(store);
      stopPolling();
    };
  }, [store]);
  return state;
}

/** Redeems the code from a pairing link once the page has loaded, then opens the match. */
export function usePairLinkRedeem(store: CommonGroundStore, loaded: boolean) {
  const [arrivals, setArrivals] = useState(0);
  useEffect(() => {
    const onPairLink = () => setArrivals((count) => count + 1);
    window.addEventListener(COMMON_GROUND_PAIR_LINK_EVENT, onPairLink);
    return () => window.removeEventListener(COMMON_GROUND_PAIR_LINK_EVENT, onPairLink);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const code = takePendingPairLink();
    if (code) void redeemPairLink(store, code);
  }, [store, loaded, arrivals]);
}
