/**
 * `common_ground.room.updated` (payload `{ code }`: a room's members, matching, themes or a
 * member's card changed) and `common_ground.matches.updated` (a match for this account finished
 * or failed) account hints. An open Grounding page refreshes the screen they concern
 * (`storeHints`). `common_ground.invitations.updated` (a person invited you to a group, or you
 * answered one on another device) refreshes Contacts › Requests (`roomInvitations`). This module
 * stays tiny: the sync stream imports it outside the lazy Grounding page.
 */
export const ROOM_HINT_TYPE = 'common_ground.room.updated';
export const MATCHES_HINT_TYPE = 'common_ground.matches.updated';
export const INVITATIONS_HINT_TYPE = 'common_ground.invitations.updated';

/** One batch of hints: the rooms that changed, and whether any match finished. */
export type CgRoomHints = { codes: string[]; matches: boolean };

type Listener = (hints: CgRoomHints) => void;
const listeners = new Set<Listener>();
const invitationListeners = new Set<() => void>();

function roomCode(payload: unknown): string | null {
  const code = payload && typeof payload === 'object' ? (payload as { code?: unknown }).code : null;
  return typeof code === 'string' && code.trim() ? code.trim() : null;
}

/** Hands room and match hints from the cloud sync stream to an open Grounding page, once per batch. */
export function notifyCommonGroundRoomEvents(events: ReadonlyArray<{ eventType?: string; payload?: unknown }>) {
  const codes = new Set<string>();
  let matches = false;
  let invitations = false;
  for (const event of events) {
    if (event.eventType === MATCHES_HINT_TYPE) matches = true;
    else if (event.eventType === INVITATIONS_HINT_TYPE) invitations = true;
    else if (event.eventType === ROOM_HINT_TYPE) {
      // A room hint without a code names no screen to refresh.
      const code = roomCode(event.payload);
      if (code) codes.add(code);
    }
  }
  if (invitations) for (const listener of [...invitationListeners]) listener();
  if (!codes.size && !matches) return;
  const hints: CgRoomHints = { codes: [...codes], matches };
  for (const listener of [...listeners]) listener(hints);
}

export function subscribeRoomHints(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Person invitations to groups changed for this account, once per batch. */
export function subscribeInvitationHints(listener: () => void): () => void {
  invitationListeners.add(listener);
  return () => { invitationListeners.delete(listener); };
}
