// Dependency-free relay from low-level request code (the error parser, the
// session store, the browser session backend, sockets) to the code that ends a
// deleted account's session, so those modules never import the session
// teardown.

/** The close code of a socket whose account was deleted. */
export const ACCOUNT_DELETED_CLOSE_CODE = 4410;

/**
 * Which account the server reported deleted. `token` is the credential the
 * request used; `accountId` names the account directly. With neither, the
 * report is about the session this window holds now.
 */
export type AccountDeletedReport = { token?: string | null; accountId?: string | null };

type Listener = (report: AccountDeletedReport) => Promise<unknown> | void;

const listeners = new Set<Listener>();

export function onAccountDeleted(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The server answered `account_deleted`. Resolves once every listener has
 * finished, with whether any listener heard it.
 */
export async function signalAccountDeleted(report: AccountDeletedReport): Promise<boolean> {
  const current = [...listeners];
  await Promise.allSettled(current.map(async (listener) => listener(report)));
  return current.length > 0;
}
