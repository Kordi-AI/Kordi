/**
 * `common_ground.gallery.updated` account hints (payload `{ code, itemId }`): someone shared to a
 * room's Gallery, removed an item, or added or deleted a comment. An open Grounding page refetches
 * that room's Gallery and the open item (`storeGallery`). This module stays tiny: the sync stream
 * imports it outside the lazy Grounding page.
 */
export const GALLERY_HINT_TYPE = 'common_ground.gallery.updated';

export type CgGalleryHint = { code: string; itemId: string | null };

type Listener = (hints: CgGalleryHint[]) => void;
const listeners = new Set<Listener>();

function hintOf(payload: unknown): CgGalleryHint | null {
  const raw = payload && typeof payload === 'object' ? payload as { code?: unknown; itemId?: unknown } : {};
  const code = typeof raw.code === 'string' ? raw.code.trim() : '';
  if (!code) return null;
  return { code, itemId: typeof raw.itemId === 'string' && raw.itemId.trim() ? raw.itemId.trim() : null };
}

/** Hands gallery hints from the cloud sync stream to an open Grounding page, once per batch. */
export function notifyCommonGroundGalleryEvents(events: ReadonlyArray<{ eventType?: string; payload?: unknown }>) {
  const hints = new Map<string, CgGalleryHint>();
  for (const event of events) {
    if (event.eventType !== GALLERY_HINT_TYPE) continue;
    // A hint without a room code names nothing to refresh.
    const hint = hintOf(event.payload);
    if (hint) hints.set(`${hint.code}\u0000${hint.itemId ?? ''}`, hint);
  }
  if (!hints.size) return;
  const batch = [...hints.values()];
  for (const listener of [...listeners]) listener(batch);
}

export function subscribeGalleryHints(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
