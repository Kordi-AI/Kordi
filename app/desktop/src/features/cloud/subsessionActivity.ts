/**
 * A same-page hint that a background session's execution may have changed:
 * a message was sent to it, or a follow-up turn started or ended on this Mac.
 * Views that poll the session refresh at once instead of at their next poll.
 */
const SUBSESSION_ACTIVITY_EVENT = 'kordi:subsession-activity';

export function notifySubsessionActivity(sessionId: string): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(SUBSESSION_ACTIVITY_EVENT, { detail: { sessionId } }));
}

export function onSubsessionActivity(sessionId: string, listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => undefined;
  const handle = (event: Event) => {
    if ((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId === sessionId) listener();
  };
  window.addEventListener(SUBSESSION_ACTIVITY_EVENT, handle);
  return () => window.removeEventListener(SUBSESSION_ACTIVITY_EVENT, handle);
}
