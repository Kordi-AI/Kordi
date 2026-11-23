import assert from 'node:assert/strict';
import test from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';

test('a profile avatar upload sends the bytes separately and activates the returned reference', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const uploadedAsset = 'kordi-avatar://uploaded/ava_0123456789abcdef0123456789abcdef';
  const avatar = (uploaded: boolean) => ({
    entityType: 'human',
    entityId: 'acct_1',
    source: uploaded ? 'uploaded' : 'generated',
    style: 'lorelei',
    seed: 'profile_seed',
    rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0',
    uploadedAsset: uploaded ? uploadedAsset : null,
    version: uploaded ? 2 : 1,
    updatedAt: '2026-08-25T00:00:00Z',
  });
  const account = (uploaded: boolean) => ({
    accountId: 'acct_1',
    displayName: 'Ada',
    primaryEmail: 'ada@example.com',
    avatarUrl: uploaded ? uploadedAsset : null,
    avatar: avatar(uploaded),
    passwordSet: true,
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/avatar-assets')) {
      return Response.json({ uploadedAsset });
    }
    return Response.json(account(init?.method === 'PATCH'));
  };
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await client.me('kordi_cs_abc');
  const result = await client.updateProfile('kordi_cs_abc', {
    avatarMutation: { action: 'upload', uploadedAsset: 'data:image/jpeg;base64,/9j/', expectedVersion: 1 },
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'http://srv/v1/cloud/auth/me');
  assert.match(calls[1].url, /\/v1\/cloud\/avatar-assets\?entityType=human&entityId=acct_1$/);
  assert.ok(calls[1].init?.body instanceof Blob);
  assert.equal(calls[2].url, 'http://srv/v1/cloud/auth/me');
  assert.equal(calls[2].init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[2].init?.body as string).avatarMutation, {
    action: 'upload',
    uploadedAsset,
    expectedVersion: 1,
  });
  assert.equal(result.avatarUrl, uploadedAsset);
});
