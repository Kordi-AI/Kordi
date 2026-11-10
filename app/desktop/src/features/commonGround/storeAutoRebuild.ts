// "Rebuild automatically" for the Common ground store: the setting, and keeping the open card
// current while the server updates it quietly. The `common_ground.card.updated` hint asks for a
// refresh; while the owner view says `autoUpdating`, the store's poll fetches the card on the
// build interval. A refresh never lands over a save in flight (a rename, a topic edit) or over a
// card that changed while it was out; it waits for the next poll instead. Every background fetch
// of the current card (the hint, the `autoUpdating` poll, and the store's sync from other devices)
// lands through `landFetchedOwner`, so topics it adds while the card page is open are marked new
// whichever fetch arrives first, until the owner leaves the page. A card that updated while
// Grounding was closed has nothing to compare with and gets no marks.

import { useEffect, useSyncExternalStore } from 'react';

import { requireAiConsent } from '@/features/aiConsent/aiConsentStore';
import { newTopics } from './cardAuto';
import { BUILD_POLL_MS, type CommonGroundStore } from './store';
import type { CgOwnerView } from './types';

/** The parts of the store these operations use. */
export type CgAutoHost = Pick<CommonGroundStore, 'client' | 'getSnapshot' | 'set' | 'run' | 'top' | 'applyOwner'>;

type NewTopics = { profileId: string | null; topics: ReadonlySet<string> };

type CardRefresh = {
  /** A hint arrived and no refresh has landed since. */
  pending: boolean;
  inFlight: boolean;
  marked: NewTopics;
  listeners: Set<() => void>;
  subscribe: (listener: () => void) => () => void;
  snapshot: () => NewTopics;
};

const NONE: ReadonlySet<string> = new Set();
const refreshes = new WeakMap<object, CardRefresh>();

function refreshOf(host: object): CardRefresh {
  let refresh = refreshes.get(host);
  if (!refresh) {
    const created: CardRefresh = {
      pending: false,
      inFlight: false,
      marked: { profileId: null, topics: NONE },
      listeners: new Set(),
      subscribe: (listener) => {
        created.listeners.add(listener);
        return () => { created.listeners.delete(listener); };
      },
      snapshot: () => created.marked,
    };
    refreshes.set(host, created);
    refresh = created;
  }
  return refresh;
}

function setMarked(refresh: CardRefresh, marked: NewTopics) {
  refresh.marked = marked;
  refresh.listeners.forEach((listener) => listener());
}

/** Turns "Rebuild automatically" on or off for the current card; turning it on needs AI consent. */
export async function setAutoRebuild(host: CgAutoHost, on: boolean): Promise<void> {
  if (on && !requireAiConsent()) return;
  const saved = await host.run('autoRebuild', () => host.client.setAutoRebuild(on, host.getSnapshot().profileId));
  if (saved) host.applyOwner(saved);
}

/**
 * Lands a card fetched in the background (the hint, an automatic update, a sync) when it is still
 * the card the fetch started from. On the card page, topics `before` did not have are marked new.
 * False when a save is running or the card or the selected profile changed meanwhile. The owner's
 * own saves apply through `applyOwner` and never mark.
 */
export function landFetchedOwner(host: CgAutoHost, profileId: string | null, before: CgOwnerView | null, owner: CgOwnerView): boolean {
  const now = host.getSnapshot();
  if (now.profileId !== profileId || now.busy || now.owner !== before) return false;
  const added = host.top().name === 'card' ? newTopics(before?.card, owner.card) : [];
  if (added.length) {
    const refresh = refreshOf(host);
    const kept = refresh.marked.profileId === profileId ? refresh.marked.topics : NONE;
    setMarked(refresh, { profileId, topics: new Set([...kept, ...added]) });
  }
  host.applyOwner(owner);
  return true;
}

const nextDelay = (host: CgAutoHost) => (host.getSnapshot().owner?.autoUpdating ? BUILD_POLL_MS : null);

/** True when the poll should fetch the card: a hint is waiting, or an automatic update runs. */
export function cardRefreshDue(host: CgAutoHost): boolean {
  return refreshOf(host).pending || Boolean(host.getSnapshot().owner?.autoUpdating);
}

/** The hint: fetches the cards and the current card now, or at the next poll when it cannot land yet. */
export function requestCardRefresh(host: CgAutoHost): Promise<number | null> {
  refreshOf(host).pending = true;
  return refreshCard(host);
}

/**
 * Fetches the cards and the current card again. Returns the delay before the next poll: the
 * build interval while an automatic update runs, else null. A failed fetch is quiet.
 */
export async function refreshCard(host: CgAutoHost): Promise<number | null> {
  const refresh = refreshOf(host);
  const before = host.getSnapshot();
  if (refresh.inFlight || !before.loaded || before.busy) return nextDelay(host);
  refresh.pending = false;
  refresh.inFlight = true;
  try {
    const profileId = before.profileId;
    const [profiles, owner] = await Promise.all([
      before.profilesOn ? host.client.profiles().catch(() => null) : Promise.resolve(null),
      host.client.card(profileId),
    ]);
    const now = host.getSnapshot();
    if (now.profileId !== profileId) return nextDelay(host);
    if (profiles && !now.busy && now.profiles === before.profiles) host.set({ profiles });
    if (!landFetchedOwner(host, profileId, before.owner, owner)) refresh.pending = true;
  } catch {
    // Quiet: an automatic update polls again, and the next sync picks up the rest.
  } finally {
    refresh.inFlight = false;
  }
  return nextDelay(host);
}

/** Drops the new marks, when the owner leaves the card page. */
export function clearNewTopics(host: object) {
  const refresh = refreshOf(host);
  if (refresh.marked.topics.size) setMarked(refresh, { profileId: null, topics: NONE });
}

/** The topics marked new on the open card page; leaving the page clears them. */
export function useNewTopics(host: object, profileId: string | null): ReadonlySet<string> {
  const refresh = refreshOf(host);
  const marked = useSyncExternalStore(refresh.subscribe, refresh.snapshot, refresh.snapshot);
  useEffect(() => () => clearNewTopics(host), [host]);
  return marked.profileId === profileId ? marked.topics : NONE;
}
