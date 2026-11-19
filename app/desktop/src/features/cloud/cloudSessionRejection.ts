import { CloudAuthError } from './cloudAuthError';
import { endDeletedCloudSession, isAccountDeletedError } from './cloudAccountDeletion';
import {
  clearSessionAndNotifySignedOut,
  loadSession,
  notifyCloudSessionSignedOut,
  refreshSession,
} from './session';

/**
 * Whether the server no longer accepts the session: it expired, was revoked,
 * the server's data was reset, or its account was deleted. Network errors,
 * 5xx and 429 are transient.
 */
export function isCloudSessionRejected(error: unknown): boolean {
  return error instanceof CloudAuthError && (
    (error.status === 401 && error.code === 'invalid_session')
    || isAccountDeletedError(error)
    || (error.status === 403 && error.code === 'browser_account_changed')
  );
}

let ending: { token: string; promise: Promise<boolean> } | null = null;

/**
 * Settles a session the server rejected, once however many checks report it.
 * A deleted account (`error` is `account_deleted`) ends at once and its local
 * data is erased. Otherwise a browser sign-in first tries its refresh token;
 * without one, or when the refresh token is refused too, the saved session is
 * cleared, local data is kept, and the app shows sign-in. A session that
 * changed since `token` was read, such as a new sign-in or a refresh, is left
 * alone.
 *
 * Resolves true when the session ended, false when it is still usable or the
 * refresh could not reach the server (callers retry later).
 */
export function endRejectedCloudSession(token: string, error?: unknown): Promise<boolean> {
  if (isAccountDeletedError(error)) return endDeletedCloudSession({ token });
  if (ending?.token === token) return ending.promise;
  const promise = (async () => {
    const current = await loadSession();
    if (!current) {
      notifyCloudSessionSignedOut();
      return true;
    }
    if (current.token !== token) return false;
    if (current.refreshToken) {
      // Null means the refresh token was refused and the session is already cleared.
      return (await refreshSession(current)) === null;
    }
    await clearSessionAndNotifySignedOut();
    return true;
  })().finally(() => {
    if (ending?.promise === promise) ending = null;
  });
  ending = { token, promise };
  return promise;
}

/** Ends the session `token` named when `error` says the server rejected it; other errors are ignored. */
export function endCloudSessionIfRejected(token: string, error: unknown): void {
  if (token && isCloudSessionRejected(error)) void endRejectedCloudSession(token, error).catch(() => undefined);
}

/**
 * Ends the session `token` named on any 401, such as a refused chat realtime
 * ticket, without waiting for the next profile check.
 */
export function endCloudSessionIfUnauthorized(token: string, error: unknown): void {
  if (token && error instanceof CloudAuthError && error.status === 401) {
    void endRejectedCloudSession(token, error).catch(() => undefined);
  }
}
