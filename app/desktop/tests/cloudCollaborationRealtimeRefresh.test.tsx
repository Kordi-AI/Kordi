import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CLOUD_MESSAGES_REFRESH_MS } from '../src/features/cloud/useCloudCollaborationState';
import {
  realtimeCallSyncEvent,
  realtimeHeartbeatAppliedSeq,
} from '../src/features/cloud/useCloudRealtimeMessages';

const messageSyncSource = () => readFileSync(
  new URL('../src/features/cloud/useCloudMessageSync.ts', import.meta.url),
  'utf8',
);

test('cloud bridge message polling is a low-frequency WebSocket repair path', () => {
  assert.equal(CLOUD_MESSAGES_REFRESH_MS, 15_000);
  const source = messageSyncSource();
  assert.match(source, /useCloudRepairPolling\(/);
});

test('macOS keeps the realtime WebSocket alive while its window is hidden', () => {
  const config = JSON.parse(readFileSync(
    new URL('../src-tauri/tauri.conf.json', import.meta.url),
    'utf8',
  )) as {
    app?: { windows?: Array<{ label?: string; backgroundThrottling?: string }> };
  };
  const mainWindow = config.app?.windows?.find((window) => window.label === 'main');

  assert.equal(mainWindow?.backgroundThrottling, 'disabled');
});

test('a heartbeat never reports more than this socket delivered', () => {
  // The local store can run ahead through HTTP catch-up; the server closes a
  // socket whose heartbeat claims an event it has not sent.
  assert.equal(realtimeHeartbeatAppliedSeq(12, 9), 9);
  assert.equal(realtimeHeartbeatAppliedSeq(7, 9), 7);
});

test('cloud realtime applies call lifecycle payloads before durable HTTP repair', () => {
  const event = realtimeCallSyncEvent({
    stream_seq: 42,
    event_id: 'event-call-updated',
    protocol_version: 2,
    type: 'call.updated',
    critical: true,
    conversation_id: 'conversation-1',
    entity_id: null,
    entity_version: null,
    occurred_at: '2026-08-31T16:00:00Z',
    payload: { call: { id: 'call-1', state: 'ended' } },
  });

  assert.equal(event?.eventType, 'call.updated');
  assert.deepEqual(event?.payload, {
    call: { id: 'call-1', state: 'ended' },
    sessionId: 'conversation-1',
  });
  assert.equal(realtimeCallSyncEvent({
    stream_seq: 43,
    event_id: 'event-message',
    protocol_version: 2,
    type: 'message.created',
    critical: true,
    conversation_id: 'conversation-1',
    entity_id: null,
    entity_version: null,
    occurred_at: '2026-08-31T16:00:01Z',
    payload: {},
  }), null);
});
