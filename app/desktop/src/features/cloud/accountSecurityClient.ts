import { defaultCloudAuthClient, type CloudAuthClient } from './authClient';
import { loadSession, type StoredSession } from './session';
import type { CloudSignupCodeChallenge } from './signupEmailTypes';

/** The account security routes; see docs/development/account-security.md. */
export const ACCOUNT_SECURITY_PATH = '/v1/cloud/account/security';

/** What deleting the account needs to know from `GET /v1/cloud/account/security`. */
export type AccountSecurityOverview = {
  email: { address: string | null; verified: boolean };
  password: { set: boolean };
  /** A sign-in under ten minutes old stands in for a code when there is no password. */
  recentSignIn: boolean;
};

/** The proof the server asks for: the current password, an emailed code, or none after a recent sign-in. */
export type AccountDeletionProof =
  | { currentPassword: string }
  | { verificationId: string; verificationCode: string }
  | Record<string, never>;

/** The session a deletion ended, so this device can end it without a logout call. */
export type DeletedAccountSession = Pick<StoredSession, 'token' | 'accountId'>;

export type AccountSecurityClient = {
  overview(): Promise<AccountSecurityOverview>;
  /** Emails a code to an account without a password. */
  requestCode(): Promise<CloudSignupCodeChallenge>;
  /** Deletes the signed-in account; resolves with the session it ended. */
  deleteAccount(proof: AccountDeletionProof): Promise<DeletedAccountSession>;
};

export function parseAccountSecurityOverview(value: unknown): AccountSecurityOverview {
  const body = (value ?? {}) as {
    email?: { address?: unknown; verified?: unknown } | null;
    password?: { set?: unknown } | null;
    recentSignIn?: unknown;
  };
  if (typeof body.password?.set !== 'boolean') throw new Error('The server returned an unknown account security state.');
  const address = typeof body.email?.address === 'string' ? body.email.address.trim() : '';
  return {
    email: { address: address || null, verified: body.email?.verified === true },
    password: { set: body.password.set },
    recentSignIn: body.recentSignIn === true,
  };
}

/**
 * `/v1/cloud/account/security` for the signed-in account. The Mac app sends
 * its bearer session; the browser app's transport turns the public account
 * marker into the session cookie and adds the CSRF header to writes.
 */
export function createAccountSecurityClient(
  client: Pick<CloudAuthClient, 'request'> = defaultCloudAuthClient(),
  session: () => Promise<StoredSession | null> = loadSession,
): AccountSecurityClient {
  const signedIn = async () => {
    const stored = await session();
    if (!stored?.token) throw new Error('Sign in to Kordi first.');
    return stored;
  };
  const post = (token: string, path: string, body: object, fallback: string) => client.request<unknown>(
    `${ACCOUNT_SECURITY_PATH}${path}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    fallback,
  );
  return {
    overview: async () => {
      const { token } = await signedIn();
      return parseAccountSecurityOverview(await client.request<unknown>(
        ACCOUNT_SECURITY_PATH,
        { method: 'GET', headers: { authorization: `Bearer ${token}` } },
        'Could not load your account.',
      ));
    },
    requestCode: async () => {
      const { token } = await signedIn();
      return await post(token, '/password/code', {}, 'Could not send a code.') as CloudSignupCodeChallenge;
    },
    deleteAccount: async (proof) => {
      const { token, accountId } = await signedIn();
      await post(token, '/delete', proof, 'Could not delete your account.');
      return { token, accountId };
    },
  };
}
