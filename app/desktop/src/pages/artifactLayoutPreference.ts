import { useSyncExternalStore } from 'react';

/** How a chat's Artifacts tab lays out its artifacts: thumbnails or one row each. */
export type ArtifactLayout = 'cards' | 'list';
export const ARTIFACT_LAYOUT_STORAGE_KEY = 'kordi.artifactLayout.v1';
const listeners = new Set<() => void>();
let snapshot: ArtifactLayout | undefined;

export function readStoredArtifactLayout(storage?: Pick<Storage, 'getItem'>): ArtifactLayout {
  try {
    const value = (storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined))
      ?.getItem(ARTIFACT_LAYOUT_STORAGE_KEY);
    return value === 'list' ? 'list' : 'cards';
  } catch {
    return 'cards';
  }
}

function getSnapshot(): ArtifactLayout {
  return snapshot ??= readStoredArtifactLayout();
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== ARTIFACT_LAYOUT_STORAGE_KEY) return;
  snapshot = readStoredArtifactLayout();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  if (listeners.size === 0 && typeof window !== 'undefined') {
    snapshot = readStoredArtifactLayout();
    window.addEventListener('storage', onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export function setArtifactLayout(layout: ArtifactLayout) {
  snapshot = layout;
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(ARTIFACT_LAYOUT_STORAGE_KEY, layout);
  } catch {
    // Keep the current window usable when persistent storage is unavailable.
  }
  listeners.forEach((listener) => listener());
}

/** Forgets the in-memory choice so tests start from storage. */
export function resetArtifactLayoutForTests() {
  snapshot = undefined;
}

export function useArtifactLayout() {
  return useSyncExternalStore(subscribe, getSnapshot, () => 'cards' as const);
}
