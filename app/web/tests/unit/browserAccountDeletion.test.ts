import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserSessionMarker } from '@web/auth/browserAppRuntime';
import { withBrowserSession } from '@web/auth/browserSessionTransport';
import { browserSiteSignInRedirectUrl, signOutWithoutReturn } from '@web/auth/browserSiteSignIn';
import { CloudAuthClient } from '@/features/cloud/authClient';
import { createAccountSecurityClient } from '@/features/cloud/accountSecurityClient';
import { endDeletedCloudSession, type DeletedSessionTeardown } from '@/features/cloud/cloudAccountDeletion';

const origin = 'https://web.example.test';
const marker = browserSessionMarker('acct_browser');

test('the browser app deletes with its cookie and CSRF header, then leaves for the site sign-in without a return path', async () => {
  const requests: Request[] = [];
  const transport = withBrowserSession(async (input, init) => {
    requests.push(new Request(input, init));
    return new Response(null, { status: 204 });
  }, origin, () => '__Host-kordi_web_csrf=synthetic-csrf');
  const security = createAccountSecurityClient(
    new CloudAuthClient({ baseUrl: origin, fetchImpl: transport }),
    async () => ({ token: marker, accountId: 'acct_browser', expiresAt: '2099-01-01T00:00:00Z' }),
  );

  const session = await security.deleteAccount({ verificationId: 'reauth_1', verificationCode: '123456' });
  assert.deepEqual(session, { token: marker, accountId: 'acct_browser' });
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).pathname, '/v1/cloud/account/security/delete');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.get('authorization'), null);
  assert.equal(requests[0].headers.get('x-kordi-web-account'), 'acct_browser');
  assert.equal(requests[0].headers.get('x-kordi-csrf-token'), 'synthetic-csrf');
  assert.equal(requests[0].credentials, 'same-origin');
  assert.deepEqual(await requests[0].json(), { verificationId: 'reauth_1', verificationCode: '123456' });

  // Before the deletion, a signed-out page would come back to where it was.
  assert.equal(browserSiteSignInRedirectUrl(`${origin}/app/contacts`), '/login?next=%2Fapp%2Fcontacts');
  const steps: string[] = [];
  const teardown: DeletedSessionTeardown = {
    current: () => null,
    erase: async (accountId) => { steps.push(`erase:${accountId}`); },
    eraseStorage: (accountId) => { steps.push(`storage:${accountId}`); },
    leaveWithoutReturn: () => { steps.push('leave'); signOutWithoutReturn(); },
    endSession: async () => { steps.push('end'); },
  };
  assert.equal(await endDeletedCloudSession(session, teardown), true);
  // The account's browser data is erased before the page leaves; no logout request follows.
  assert.deepEqual(steps, ['erase:acct_browser', 'leave', 'end', 'storage:acct_browser']);
  assert.equal(requests.length, 1);
  assert.equal(browserSiteSignInRedirectUrl(`${origin}/app/contacts`), '/login');
});
