// How Delete account confirms it is the account holder, following the
// server's proof rules: the current password when the account has one, else
// a sign-in under ten minutes old, else a code emailed to the primary email.
import type { AccountSecurityOverview } from './accountSecurityClient';
import { CloudAuthError, rateLimitedMessage } from './cloudAuthError';

export type AccountDeletionProofMode =
  | 'password'
  | 'recent-sign-in'
  | 'email-code'
  /** No password, no email for a code, and no recent sign-in. */
  | 'sign-in-again';

export const ACCOUNT_DELETION_SUMMARY = "Your account, contacts, files, agents and memories are deleted. This can't be undone.";
export const ACCOUNT_DELETION_SIGN_IN_AGAIN = 'Sign in again to delete your account.';

export function accountDeletionProofMode(overview: AccountSecurityOverview): AccountDeletionProofMode {
  if (overview.password.set) return 'password';
  if (overview.recentSignIn) return 'recent-sign-in';
  return overview.email.address ? 'email-code' : 'sign-in-again';
}

/** The proof a refused request asks for instead of `current`. */
export function accountDeletionProofModeAfter(
  error: unknown,
  current: AccountDeletionProofMode,
  hasEmail: boolean,
): AccountDeletionProofMode {
  if (!(error instanceof CloudAuthError)) return current;
  switch (error.code) {
    case 'current_password_required': return 'password';
    case 'reauthentication_required': return hasEmail ? 'email-code' : 'sign-in-again';
    case 'email_missing': return 'sign-in-again';
    default: return current;
  }
}

/** One short line for a refused request; null when the proof step says it all. */
export function accountDeletionErrorMessage(error: unknown, fallback: string): string | null {
  if (!(error instanceof CloudAuthError)) return fallback;
  switch (error.code) {
    case 'current_password_required': return 'Enter your current password.';
    case 'invalid_current_password': return 'That password is incorrect.';
    case 'reauthentication_required': return "Confirm it's you with an emailed code.";
    case 'email_missing': return null;
    case 'invalid_verification_code': return 'That code is invalid or expired.';
    case 'email_delivery_unavailable': return 'Email codes are unavailable right now. Try again later.';
    case 'account_changed': return 'Your account changed. Try again.';
    case 'rate_limited': return rateLimitedMessage(error);
    case 'network_error': return 'Could not reach Kordi. Check your connection.';
    default: return fallback;
  }
}
