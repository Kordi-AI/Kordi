import { useEffect, useSyncExternalStore } from 'react';

import { subscribeNearbyHints } from './nearbyHints';
import { startNearbyLocating, type NearbyLocatorState } from './nearbyLocator';
import type { CommonGroundStore } from './store';
import { nearbyStoreFor, type CgNearbyState, type CgNearbyStore } from './storeNearby';

const TICK_MS = 1_000;

export type NearbyPollingEnv = { hidden: () => boolean; now: () => number };

const browserEnv: NearbyPollingEnv = { hidden: () => typeof document !== 'undefined' && document.hidden, now: () => Date.now() };

/**
 * Refetches the open view while the window is visible, once the store's delay has passed since
 * the last fetch: every 3 s while people are being matched, else every 30 s. Returns a stop function.
 */
export function startNearbyPolling(nearby: CgNearbyStore, accountId?: string, env: NearbyPollingEnv = browserEnv): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (!env.hidden() && env.now() - nearby.fetchedAt >= nearby.pollDelay(accountId)) await nearby.poll(accountId);
    if (!stopped) timer = setTimeout(() => void tick(), TICK_MS);
  };
  timer = setTimeout(() => void tick(), TICK_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * Nearby state for a view: loads it on mount (a person page loads that person), refetches on the
 * nearby hints, and polls while `poll` is set.
 */
export function useNearby(store: CommonGroundStore, options: { accountId?: string; poll?: boolean; needs?: boolean } = {}): [CgNearbyState, CgNearbyStore] {
  const nearby = nearbyStoreFor(store);
  const state = useSyncExternalStore(nearby.subscribe, nearby.getSnapshot);
  const { accountId, poll = false, needs = false } = options;
  useEffect(() => {
    const unwatch = accountId ? nearby.watch(accountId) : () => undefined;
    void (accountId ? nearby.loadPerson(accountId) : nearby.load({ needs }));
    const stopHints = subscribeNearbyHints(() => { void nearby.refresh(); });
    const stopPolling = poll ? startNearbyPolling(nearby, accountId) : () => undefined;
    return () => {
      unwatch();
      stopHints();
      stopPolling();
    };
  }, [nearby, accountId, poll, needs]);
  return [state, nearby];
}

/** This device's location state for the Nearby views. */
export function useNearbyLocation(nearby: CgNearbyStore): NearbyLocatorState {
  return useSyncExternalStore(nearby.locator.subscribe, nearby.locator.getSnapshot);
}

/**
 * The Nearby screen's automatic location, foreground only: asks when the screen opens and when
 * `sharing` turns on or resumes, then every few minutes while it stays open.
 */
export function useNearbyAutoLocation(nearby: CgNearbyStore, sharing: boolean): void {
  const locator = nearby.locator;
  useEffect(() => locator.attach(), [locator]);
  useEffect(() => {
    if (!sharing) return undefined;
    void locator.auto();
    return startNearbyLocating(locator);
  }, [locator, sharing]);
}
