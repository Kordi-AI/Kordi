// Opening a Grounding room from elsewhere (a room invitation in Contacts › Requests), focused on
// one of its groups. Like `pairLink`, the request waits here until the Grounding page takes it,
// because Contacts switches to Grounding before the page has loaded.

/** Fired on `window` when a room should open; Contacts selects Grounding and the page opens it. */
export const COMMON_GROUND_ROOM_FOCUS_EVENT = 'kordi-common-ground-room-focus';

export type CgRoomFocus = { code: string; groupSpaceId: string };

let pending: CgRoomFocus | null = null;

/** Keeps the room and group to open and announces them. */
export function rememberRoomFocus(focus: CgRoomFocus, target: EventTarget | null = typeof window === 'undefined' ? null : window) {
  pending = focus;
  target?.dispatchEvent(new CustomEvent<CgRoomFocus>(COMMON_GROUND_ROOM_FOCUS_EVENT, { detail: focus }));
}

export function hasPendingRoomFocus(): boolean {
  return pending !== null;
}

/** The waiting room focus, once. */
export function takePendingRoomFocus(): CgRoomFocus | null {
  const focus = pending;
  pending = null;
  return focus;
}
