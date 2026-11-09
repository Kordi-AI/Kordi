// Shared fixtures for the Grounding › Nearby screen tests: settings, people, a mock-server store,
// the screen itself, this device's location, and mounting helpers.

import assert from 'node:assert/strict';

import { act, createElement, useSyncExternalStore } from 'react';

import type { CgHost } from '../../src/features/commonGround/host';
import { NearbyScreen } from '../../src/features/commonGround/NearbyScreen';
import { CommonGroundStore } from '../../src/features/commonGround/store';
import { nearbyStoreFor } from '../../src/features/commonGround/storeNearby';

import { mockServer, owner, profile, type Reply } from './commonGroundServer';
import { installDom } from './transcriptAttachmentDom';

export const work = profile('cgp_work', 'work', 'Work', true);
export const workshops = profile('cgp_ws', 'custom', 'Workshops', true, { design: 'workshop' });
export const health = profile('cgp_health', 'health', 'Health', false);

export const fresh = () => ({ capturedAt: new Date(Date.now() - 3 * 60_000 - 5_000).toISOString(), freshUntil: new Date(Date.now() + 27 * 60_000).toISOString(), fresh: true });
export const settings = (patch: Record<string, unknown> = {}) => ({
  enabled: true, participating: true, pausedUntil: null, consentedAt: '2026-10-26T09:00:00Z', profileId: 'cgp_work', openTo: ['Coffee chat'],
  range: 2000, minScore: 0, alerts: { requests: true, matches: true, matchMinScore: 85, maxPerDay: 3 }, location: fresh(), freshSeconds: 1800, ...patch,
});
export const maya = {
  person: { accountId: 'acct_maya', name: 'Maya Chen', avatarUrl: null, profile: { profileId: 'cgp_maya', kind: 'work', name: 'Work' } },
  relationship: { contact: false, request: null, requestId: null, conversationId: null },
  distance: { minMeters: 0, maxMeters: 500 }, openTo: ['Collaborating'], status: 'ready', score: 92, headline: 'Both build memory for agents',
  requests: [{ needId: 'cgn_1', text: 'Someone founding a startup' }],
};
export const people = { people: [maya], matching: 2, location: fresh() };

export const host: CgHost = {
  self: { accountId: 'acct_you', name: 'Alex Kim', avatarUrl: null },
  profiles: true,
  nearby: true,
  memoryAvailable: false,
  openChat: () => undefined,
  acceptRequest: async () => undefined,
  contactsChanged: () => undefined,
  openGroup: () => undefined,
  connectors: null,
  agentFiles: null,
  device: null,
  openUrl: () => undefined,
};

export function storeWith(routes: Record<string, Reply | Reply[]>) {
  const server = mockServer(routes);
  const store = new CommonGroundStore(server.client, { profiles: true });
  store.set({ profiles: [work, workshops, health], profileId: 'cgp_work', owner: owner(), loaded: true });
  return { ...server, store };
}

export function Screen({ store }: { store: CommonGroundStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return createElement(NearbyScreen, { state, store, host });
}

/** This device answers location requests with a fix; returns how many were asked for. */
export function deviceAnswers(store: CommonGroundStore, available = true) {
  const locator = nearbyStoreFor(store).locator;
  let requests = 0;
  const device = { available };
  locator.env = {
    ...locator.env,
    available: () => device.available,
    locate: async () => {
      requests += 1;
      return { latitude: 40.123, longitude: -75.654, accuracy: 50, capturedAt: new Date().toISOString() };
    },
  };
  return { device, requests: () => requests };
}

export const settle = () => act(async () => { for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });

/** Mounts an element; React DOM loads after the window exists so it listens for input events. */
export async function mount(element: ReturnType<typeof createElement>, run: (root: HTMLElement) => Promise<void>) {
  const installed = installDom();
  const { createRoot } = await import('react-dom/client');
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => root.render(element));
    await settle();
    await run(node);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
}

export const click = async (element: Element | null | undefined) => {
  assert.ok(element, 'element to click');
  await act(async () => { (element as HTMLElement).click(); });
  await settle();
};
export const buttonNamed = (scope: ParentNode, text: string) => [...scope.querySelectorAll('button')].find((button) => button.textContent?.trim() === text);
