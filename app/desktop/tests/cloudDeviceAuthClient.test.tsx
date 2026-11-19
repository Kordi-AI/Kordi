import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';

type FetchCall = { url: string; init: RequestInit | undefined };

const testDevice = {
  displayName: 'Ada’s Mac',
  platform: 'macos',
  osVersion: '15.6',
  appVersion: '0.0.1-beta.12',
  approximateLocation: 'Riyadh, Saudi Arabia',
  publicKey: 'test-public-key',
  keyAlgorithm: 'p256' as const,
};

function recordingFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(handler(call));
  };
  return { calls, fetchImpl };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('device management uses authenticated scoped routes and stable operation IDs', async () => {
  const { calls, fetchImpl } = recordingFetch((call) => {
    if (call.init?.method === 'GET') return jsonResponse(200, { devices: [] });
    return jsonResponse(200, { affectedDeviceIds: ['device_other'] });
  });
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl,
    deviceRegistration: async () => testDevice,
  });

  await client.listDevices('kordi_cs_xyz');
  await client.renameDevice('kordi_cs_xyz', 'device/other', 'Travel Mac', 'operation-rename');
  await client.confirmDevice('kordi_cs_xyz', 'device/other', 'operation-confirm');
  await client.revokeDevice('kordi_cs_xyz', 'device/other', 'operation-1');
  await client.revokeOtherDevices('kordi_cs_xyz', 'operation-2');

  assert.deepEqual(calls.map((call) => [new URL(call.url).pathname, call.init?.method]), [
    ['/v1/cloud/auth/devices/current', 'PUT'],
    ['/v1/cloud/auth/devices', 'GET'],
    ['/v1/cloud/auth/devices/device%2Fother', 'PATCH'],
    ['/v1/cloud/auth/devices/device%2Fother/confirm', 'POST'],
    ['/v1/cloud/auth/devices/device%2Fother', 'DELETE'],
    ['/v1/cloud/auth/devices/revoke-others', 'POST'],
  ]);
  for (const call of calls) {
    assert.equal((call.init?.headers as Record<string, string>).authorization, 'Bearer kordi_cs_xyz');
  }
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
    displayName: 'Ada’s Mac',
    platform: 'macos',
    osVersion: '15.6',
    appVersion: '0.0.1-beta.12',
    approximateLocation: 'Riyadh, Saudi Arabia',
  });
  assert.deepEqual(JSON.parse(calls[2].init?.body as string), {
    clientOperationId: 'operation-rename',
    displayName: 'Travel Mac',
  });
  assert.equal(JSON.parse(calls[3].init?.body as string).clientOperationId, 'operation-confirm');
  assert.equal(JSON.parse(calls[4].init?.body as string).clientOperationId, 'operation-1');
  assert.equal(JSON.parse(calls[5].init?.body as string).clientOperationId, 'operation-2');
});
