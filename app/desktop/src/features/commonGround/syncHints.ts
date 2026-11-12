// Grounding's account hints from the cloud sync stream, handed on in one call: Nearby
// (`nearbyHints`), card builds (`cardHints`), and rooms and matches (`roomHints`). Like those
// modules this one stays tiny: the sync stream imports it outside the lazy Grounding page.

import { notifyCommonGroundCardEvents } from './cardHints';
import { notifyCommonGroundNearbyEvents } from './nearbyHints';
import { notifyCommonGroundRoomEvents } from './roomHints';

export function notifyCommonGroundSyncEvents(events: ReadonlyArray<{ eventType?: string; payload?: unknown }>) {
  notifyCommonGroundNearbyEvents(events);
  notifyCommonGroundCardEvents(events);
  notifyCommonGroundRoomEvents(events);
}
