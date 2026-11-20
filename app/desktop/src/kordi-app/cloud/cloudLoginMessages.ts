import { clientDistribution } from '@/features/cloud/distribution';
import type { CloudAuthError } from '@/features/cloud/authClient';
import { rateLimitedMessage } from '@/features/cloud/cloudAuthError';

/** Readable text for account errors, such as verifying the account email. */
export function cloudLoginErrorMessage(error: CloudAuthError): string {
  switch (error.code) {
    case 'email_already_verified':
      return error.message || 'This email is already verified.';
    case 'email_delivery_unavailable':
      return error.message || 'Email verification is temporarily unavailable. Try again later.';
    case 'email_missing':
      return error.message || 'This account has no email address to verify.';
    case 'rate_limited':
      return rateLimitedMessage(error);
    case 'invalid_session':
    case 'account_missing':
      return 'Your session expired. Please sign in again.';
    case 'network_error':
      return 'Could not reach the cloud server. Check your connection and try again.';
    case 'server_error':
      return 'The server hit an unexpected error. Please try again.';
    default:
      return error.message || 'Something went wrong.';
  }
}

/** The welcome screen title, from the build's distribution when it sets one. */
export function loginHeading(): string {
  return clientDistribution()?.loginPage?.title ?? 'Welcome to Kordi';
}

export function loginSubtitle(): string {
  return clientDistribution()?.loginPage?.subtitle ?? 'Building Next-generation Supercollaboration';
}
