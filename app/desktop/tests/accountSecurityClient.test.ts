import assert from 'node:assert/strict';
import test from 'node:test';

import { CloudAuthClient, CloudAuthError } from '../src/features/cloud/authClient';
import {
  ACCOUNT_SECURITY_PATH,
  createAccountSecurityClient,
  parseAccountSecurityOverview,
} from '../src/features/cloud/accountSecurityClient';
import {
  accountDeletionErrorMessage,
  accountDeletionProofMode,
  accountDeletionProofModeAfter,
} from '../src/features/cloud/accountDeletionProof';

const session = { token: 'synthetic-token', accountId: 'acct_owner', expiresAt: '2099-01-01T00:00:00Z' };
const overviewBody = {
  email: { address: 'owner@example.test', verified: true },
  password: { set: false, updatedAt: null },
  providers: [],
  sessions: [],
  canManageOtherSessions: true,
  recentSignIn: false,
};

type Call = { url: string; init: RequestInit | undefined };

function securityClient(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async (url, init) => {
      const call = { url: String(url), init };
      calls.push(call);
      return respond(call);
    },
  });
  return { calls, security: createAccountSecurityClient(client, async () => session) };
}

const headers = (call: Call) => new Headers(call.init?.headers);

test('the overview reads the security page with the session token', async () => {
  const { calls, security } = securityClient(() => Response.json(overviewBody));
  assert.deepEqual(await security.overview(), {
    email: { address: 'owner@example.test', verified: true },
    password: { set: false },
    recentSignIn: false,
  });
  assert.equal(calls[0].url, `http://srv${ACCOUNT_SECURITY_PATH}`);
  assert.equal(calls[0].init?.method, 'GET');
  assert.equal(headers(calls[0]).get('authorization'), 'Bearer synthetic-token');
});

test('the overview tolerates missing optional fields and refuses an unknown shape', () => {
  assert.deepEqual(parseAccountSecurityOverview({ email: { address: '  ' }, password: { set: true } }), {
    email: { address: null, verified: false },
    password: { set: true },
    recentSignIn: false,
  });
  assert.equal(parseAccountSecurityOverview({ email: null, password: { set: false }, recentSignIn: true }).recentSignIn, true);
  assert.throws(() => parseAccountSecurityOverview({ email: { address: 'owner@example.test' } }));
  assert.throws(() => parseAccountSecurityOverview(null));
});

test('a code request posts an empty body to the password code route', async () => {
  const challenge = { verificationId: 'reauth_1', expiresAt: '2099-01-01T00:00:00Z', retryAfterSeconds: 60 };
  const { calls, security } = securityClient(() => Response.json(challenge));
  assert.deepEqual(await security.requestCode(), challenge);
  assert.equal(calls[0].url, `http://srv${ACCOUNT_SECURITY_PATH}/password/code`);
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(headers(calls[0]).get('content-type'), 'application/json');
  assert.equal(headers(calls[0]).get('authorization'), 'Bearer synthetic-token');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {});
});

test('a deletion posts the proof and resolves with the session it ended on 204', async () => {
  for (const proof of [
    { currentPassword: 'Synthetic-pass-1' },
    { verificationId: 'reauth_1', verificationCode: '123456' },
    {},
  ]) {
    const { calls, security } = securityClient(() => new Response(null, { status: 204 }));
    assert.deepEqual(await security.deleteAccount(proof), { token: 'synthetic-token', accountId: 'acct_owner' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `http://srv${ACCOUNT_SECURITY_PATH}/delete`);
    assert.equal(calls[0].init?.method, 'POST');
    assert.equal(headers(calls[0]).get('content-type'), 'application/json');
    assert.equal(headers(calls[0]).get('authorization'), 'Bearer synthetic-token');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), proof);
  }
});

test('refusals keep the server error code', async () => {
  for (const [code, status] of [
    ['current_password_required', 403],
    ['reauthentication_required', 403],
    ['invalid_current_password', 403],
    ['account_changed', 409],
    ['email_missing', 400],
    ['invalid_verification_code', 400],
    ['email_delivery_unavailable', 503],
    ['rate_limited', 429],
  ] as const) {
    const { security } = securityClient(() => Response.json(
      { errorCode: code, message: 'Server text.' },
      { status, headers: code === 'rate_limited' ? { 'retry-after': '42' } : {} },
    ));
    await assert.rejects(
      security.deleteAccount({ currentPassword: 'x' }),
      (error: unknown) => error instanceof CloudAuthError && error.code === code && error.status === status
        && (code !== 'rate_limited' || error.retryAfterSeconds === 42),
      code,
    );
  }
});

test('a client without a session refuses before any request', async () => {
  let requests = 0;
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl: async () => { requests += 1; return Response.json({}); } });
  const security = createAccountSecurityClient(client, async () => null);
  await assert.rejects(security.deleteAccount({}), /Sign in/);
  assert.equal(requests, 0);
});

test('the proof follows the server rules: password, recent sign-in, emailed code, or sign in again', () => {
  const overview = parseAccountSecurityOverview(overviewBody);
  assert.equal(accountDeletionProofMode({ ...overview, password: { set: true }, recentSignIn: true }), 'password');
  assert.equal(accountDeletionProofMode({ ...overview, recentSignIn: true }), 'recent-sign-in');
  assert.equal(accountDeletionProofMode(overview), 'email-code');
  assert.equal(accountDeletionProofMode({ ...overview, email: { address: null, verified: false } }), 'sign-in-again');

  const refusal = (code: 'current_password_required' | 'reauthentication_required' | 'email_missing' | 'invalid_current_password') => (
    new CloudAuthError(code, '', 403)
  );
  assert.equal(accountDeletionProofModeAfter(refusal('current_password_required'), 'recent-sign-in', true), 'password');
  assert.equal(accountDeletionProofModeAfter(refusal('reauthentication_required'), 'recent-sign-in', true), 'email-code');
  assert.equal(accountDeletionProofModeAfter(refusal('reauthentication_required'), 'recent-sign-in', false), 'sign-in-again');
  assert.equal(accountDeletionProofModeAfter(refusal('email_missing'), 'email-code', true), 'sign-in-again');
  assert.equal(accountDeletionProofModeAfter(refusal('invalid_current_password'), 'password', true), 'password');
  assert.equal(accountDeletionProofModeAfter(new Error('offline'), 'password', true), 'password');
});

test('refusals read as one short line', () => {
  const message = (code: ConstructorParameters<typeof CloudAuthError>[0], retryAfter?: number) => (
    accountDeletionErrorMessage(new CloudAuthError(code, 'Server text.', 400, retryAfter), 'Fallback.')
  );
  assert.equal(message('current_password_required'), 'Enter your current password.');
  assert.equal(message('invalid_current_password'), 'That password is incorrect.');
  assert.equal(message('reauthentication_required'), "Confirm it's you with an emailed code.");
  assert.equal(message('email_missing'), null);
  assert.equal(message('invalid_verification_code'), 'That code is invalid or expired.');
  assert.equal(message('account_changed'), 'Your account changed. Try again.');
  assert.equal(message('rate_limited', 42), 'Too many attempts. Try again in 42 seconds.');
  assert.equal(message('server_error'), 'Fallback.');
  assert.equal(accountDeletionErrorMessage(new Error('boom'), 'Fallback.'), 'Fallback.');
});
