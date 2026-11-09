import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'kordi.desktop-auto-update.v1';
const listeners = new Set<() => void>();
let cached: boolean | null = null;

/** Automatic updates are on unless the user turned them off on this Mac. */
export function readAutoUpdatePreference() {
  if (cached !== null) return cached;
  try {
    cached = typeof window === 'undefined' || window.localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    cached = true;
  }
  return cached;
}

export function setAutoUpdatePreference(enabled: boolean) {
  cached = enabled;
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // The choice still applies for this launch.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAutoUpdatePreference() {
  return useSyncExternalStore(subscribe, readAutoUpdatePreference, () => true);
}
