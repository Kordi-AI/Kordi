/**
 * `common_ground.room.updated` (payload `{ code }`: a room's members, matching, themes or a
 * member's card changed) and `common_ground.matches.updated` (a match for this account finished
 * or failed) account hints. An open Grounding page refreshes the screen they concern
 * (`storeHints`). This module stays tiny: the sync stream imports it outside the lazy Grounding page.
 */
export const ROOM_HINT_TYPE = 'common_ground.room.updated';
export const MATCHES_HINT_TYPE = 'common_ground.matches.updated';

/** One batch of hints: the rooms that changed, and whether any match finished. */
export type CgRoomHints = { codes: string[]; matches: boolean };

type Listener = (hints: CgRoomHints) => void;
const listeners = new Set<Listener>();

function roomCode(payload: unknown): string | null {
  const code = payload && typeof payload === 'object' ? (payload as { code?: unknown }).code : null;
  return typeof code === 'string' && code.trim() ? code.trim() : null;
}

/** Hands room and match hints from the cloud sync stream to an open Grounding page, once per batch. */
export function notifyCommonGroundRoomEvents(events: ReadonlyArray<{ eventType?: string; payload?: unknown }>) {
  const codes = new Set<string>();
  let matches = false;
  for (const event of events) {
    if (event.eventType === MATCHES_HINT_TYPE) matches = true;
    else if (event.eventType === ROOM_HINT_TYPE) {
      // A room hint without a code names no screen to refresh.
      const code = roomCode(event.payload);
      if (code) codes.add(code);
    }
  }
  if (!codes.size && !matches) return;
  const hints: CgRoomHints = { codes: [...codes], matches };
  for (const listener of [...listeners]) listener(hints);
}

export function subscribeRoomHints(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
