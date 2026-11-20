// Ends the session of an account the server reports deleted: a request
// answered `401 account_deleted`, a refresh answered `account_deleted`, a
// socket closed with code 4410, or this device deleted the account itself.
// The session ends without a logout call (the server already ended it), the
// account's local data is erased, and the app shows sign-in; the browser app
// goes to the site sign-in without a return path. A plain rejected session
// (`invalid_session`) keeps its data; see cloudSessionRejection.
import { browserSessionAccountId, isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import { signOutWithoutReturn } from '@web/auth/browserSiteSignIn';
import { ACCOUNT_DELETED_CLOSE_CODE, onAccountDeleted, type AccountDeletedReport } from './accountDeletedSignal';
import { eraseAccountLocalStorage, eraseCloudAccountLocalData } from './cloudAccountLocalData';
import { CloudAuthError } from './cloudAuthError';
import { cachedSessionSnapshot, clearSessionAndNotifySignedOut, type StoredSession } from './session';

export { ACCOUNT_DELETED_CLOSE_CODE } from './accountDeletedSignal';

export function isAccountDeletedError(error: unknown): boolean {
  return error instanceof CloudAuthError && error.status === 401
    && (error.code === 'account_deleted' || error.serverCode === 'account_deleted');
}

export function isAccountDeletedClose(event: { code?: number } | null | undefined): boolean {
  return event?.code === ACCOUNT_DELETED_CLOSE_CODE;
}

/**
 * The account a report names: its own id, the account of its credential, or
 * the current session's account when it names neither. Null when no account
 * is known; undefined when the credential is not the current session's, so
 * the report is about a session that has already changed.
 */
export function deletedAccountId(report: AccountDeletedReport, current: StoredSession | null): string | null | undefined {
  const accountId = report.accountId?.trim();
  if (accountId) return accountId;
  const token = report.token?.trim();
  if (!token) return current?.accountId ?? null;
  const browserAccountId = browserSessionAccountId(token);
  if (browserAccountId) return browserAccountId;
  return current?.token === token ? current.accountId : undefined;
}

export type DeletedSessionTeardown = {
  current: () => StoredSession | null;
  erase: (accountId: string) => Promise<void>;
  eraseStorage: (accountId: string) => void;
  /** Browser app: the sign-in redirect carries no return path. */
  leaveWithoutReturn: () => void;
  /** Clears the saved session without a logout call and shows sign-in. */
  endSession: () => Promise<void>;
};

const defaultTeardown: DeletedSessionTeardown = {
  current: cachedSessionSnapshot,
  erase: (accountId) => eraseCloudAccountLocalData(accountId),
  eraseStorage: (accountId) => { eraseAccountLocalStorage(accountId); },
  leaveWithoutReturn: () => { if (isBrowserAppRuntime()) signOutWithoutReturn(); },
  endSession: clearSessionAndNotifySignedOut,
};

const ending = new Map<string, Promise<boolean>>();
const ended = new Set<string>();

/**
 * Ends a deleted account's session once, however many requests and sockets
 * report it. Resolves true when it ended a session (or one was already
 * ended), false when the report is about a session that has since changed.
 */
export function endDeletedCloudSession(
  report: AccountDeletedReport = {},
  teardown: DeletedSessionTeardown = defaultTeardown,
): Promise<boolean> {
  const current = teardown.current();
  const accountId = deletedAccountId(report, current);
  if (accountId === undefined) return Promise.resolve(false);
  const key = accountId ?? '';
  const running = ending.get(key);
  if (running) return running;
  if (accountId && ended.has(accountId) && current?.accountId !== accountId) return Promise.resolve(true);
  const promise = (async () => {
    // Erase first: the browser app leaves the page once it is signed out.
    if (accountId) await teardown.erase(accountId).catch(() => undefined);
    teardown.leaveWithoutReturn();
    const now = teardown.current();
    // A different account signed in meanwhile keeps its session.
    if (!now || !accountId || now.accountId === accountId) await teardown.endSession();
    if (accountId) {
      // Writes that were in flight while the session ended are removed too.
      teardown.eraseStorage(accountId);
      ended.add(accountId);
    }
    return true;
  })().finally(() => {
    if (ending.get(key) === promise) ending.delete(key);
  });
  ending.set(key, promise);
  return promise;
}

/** Ends the session when `event` is a socket close for a deleted account. */
export function endSessionIfAccountDeletedClose(event: { code?: number } | null | undefined, token: string | null): boolean {
  if (!isAccountDeletedClose(event)) return false;
  void endDeletedCloudSession(token ? { token } : {}).catch(() => undefined);
  return true;
}

onAccountDeleted((report) => endDeletedCloudSession(report));
