/**
 * `common_ground.card.updated` account hints: a build of one of the owner's cards finished, by
 * hand or automatically. An open Grounding page refetches its cards when one arrives. This module
 * stays tiny: the sync stream imports it outside the lazy Grounding page.
 */
export const CARD_HINT_TYPE = 'common_ground.card.updated';

type Listener = () => void;
const listeners = new Set<Listener>();

/** Hands card hints from the cloud sync stream to an open Grounding page, once per batch. */
export function notifyCommonGroundCardEvents(events: ReadonlyArray<{ eventType?: string }>) {
  if (!events.some((event) => event.eventType === CARD_HINT_TYPE)) return;
  for (const listener of [...listeners]) listener();
}

export function subscribeCardHints(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
