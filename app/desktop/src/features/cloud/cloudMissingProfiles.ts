import { CloudAuthError } from './cloudAuthError';

/**
 * Accounts whose public profile answered "no account", per signed-in account.
 * A deleted account stays gone, so group sync asks for its profile once, not
 * again for every message or directory change that still names it.
 */
const missingByViewer = new Map<string, Set<string>>();

export function isMissingCloudProfileError(error: unknown): boolean {
  return error instanceof CloudAuthError
    && (error.status === 404 || error.code === 'account_missing' || error.serverCode === 'account_missing');
}

export function rememberMissingCloudProfile(viewerAccountId: string, accountId: string): void {
  const viewer = viewerAccountId.trim();
  const missing = accountId.trim();
  if (!viewer || !missing) return;
  const accounts = missingByViewer.get(viewer) ?? new Set<string>();
  accounts.add(missing);
  missingByViewer.set(viewer, accounts);
}

export function isKnownMissingCloudProfile(viewerAccountId: string, accountId: string): boolean {
  return missingByViewer.get(viewerAccountId.trim())?.has(accountId.trim()) ?? false;
}
