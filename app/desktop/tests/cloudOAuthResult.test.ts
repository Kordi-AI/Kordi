import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCloudOAuthHashError } from '../src/features/cloud/cloudOAuthResult';

const EXISTING_ACCOUNT_MESSAGE =
  'A Kordi account already uses this email. Sign in with your email and password.';
const EXISTING_ACCOUNT_FRAGMENT = `#kordi_cloud_oauth_error=${encodeURIComponent(EXISTING_ACCOUNT_MESSAGE)}`
  + '&kordi_cloud_oauth_error_code=oauth_email_requires_sign_in';

test('OAuth callback errors keep the server message and stable code', () => {
  assert.deepEqual(parseCloudOAuthHashError(EXISTING_ACCOUNT_FRAGMENT), {
    code: 'oauth_email_requires_sign_in',
    message: EXISTING_ACCOUNT_MESSAGE,
  });
  assert.deepEqual(parseCloudOAuthHashError('#kordi_cloud_oauth_error=access_denied'), {
    code: null,
    message: 'access_denied',
  });
  assert.equal(parseCloudOAuthHashError('#kordi_cloud_oauth=e30'), null);
  assert.equal(parseCloudOAuthHashError(''), null);
});
