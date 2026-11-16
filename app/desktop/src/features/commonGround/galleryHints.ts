/**
 * `common_ground.gallery.updated` account hints (payload `{ code, itemId, itemIds, change }`; older
 * servers send only `code` and `itemId`): someone shared to a room's Gallery or removed an item
 * (`list`), or added or deleted a comment or refreshed an item's title or preview (`item`). An open
 * Grounding page refetches that room's Gallery or only the named items (`storeGallery`). This module
 * stays tiny: the sync stream imports it outside the lazy Grounding page.
 */
export const GALLERY_HINT_TYPE = 'common_ground.gallery.updated';

/** `list`: items were shared or removed. `item`: the named items changed in place. */
export type CgGalleryChange = 'list' | 'item';
/** `itemIds` names every item the change touched; `itemId` is the first of them. */
export type CgGalleryHint = { code: string; itemId: string | null; itemIds: string[]; change: CgGalleryChange };

type Listener = (hints: CgGalleryHint[]) => void;
const listeners = new Set<Listener>();

const idOf = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** A missing or unknown `change` reads as `list`; a missing `itemIds` as `[itemId]`. */
export function galleryHintOf(payload: unknown): CgGalleryHint | null {
  const raw = payload && typeof payload === 'object' ? payload as { code?: unknown; itemId?: unknown; itemIds?: unknown; change?: unknown } : {};
  const code = idOf(raw.code);
  if (!code) return null;
  const listed: unknown[] = Array.isArray(raw.itemIds) ? raw.itemIds : [];
  const itemIds = [...new Set([raw.itemId, ...listed].map(idOf).filter(Boolean))];
  return { code, itemId: itemIds[0] ?? null, itemIds, change: raw.change === 'item' ? 'item' : 'list' };
}

/** Hands gallery hints from the cloud sync stream to an open Grounding page, once per batch. */
export function notifyCommonGroundGalleryEvents(events: ReadonlyArray<{ eventType?: string; payload?: unknown }>) {
  const hints = new Map<string, CgGalleryHint>();
  for (const event of events) {
    if (event.eventType !== GALLERY_HINT_TYPE) continue;
    // A hint without a room code names nothing to refresh.
    const hint = galleryHintOf(event.payload);
    if (hint) hints.set([hint.code, hint.change, ...hint.itemIds].join('\u0000'), hint);
  }
  if (!hints.size) return;
  const batch = [...hints.values()];
  for (const listener of [...listeners]) listener(batch);
}

export function subscribeGalleryHints(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
