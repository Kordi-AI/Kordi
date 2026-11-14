/**
 * Which agents a person may mention can change at any time: an owner turns
 * an agent's Access to "Only me" or turns "Use my agent" off for them
 * (docs/contact-permissions.md). The composer refetches its agent list when
 * the `@` menu opens and when the window regains focus, at most once per
 * interval, so it stops offering an agent soon after the owner closes it.
 */
export const MENTION_AGENT_REFRESH_INTERVAL_MS = 5_000;

/** Returns a gate that opens at most once per `intervalMs`. */
export function mentionAgentRefreshGate(
  intervalMs = MENTION_AGENT_REFRESH_INTERVAL_MS,
  now: () => number = Date.now,
): () => boolean {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const at = now();
    if (at - last < intervalMs) return false;
    last = at;
    return true;
  };
}
