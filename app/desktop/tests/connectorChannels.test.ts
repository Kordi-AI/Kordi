// Slack channel choices: settings helpers and the cloud client calls.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  channelChoices,
  channelSettings,
  chosenChannelsFromSettings,
  filterChannelChoices,
  toggleChannel,
} from '../src/features/connectors/connectorChannels';
import { connectorStateFromSummary, createCloudConnectorsClient } from '../src/features/connectors/connectorsCloudClient';
import { isConnectorNeedsReconnect } from '../src/features/connectors/connectorsErrors';
import { ACCOUNT_ID, cloudFixture, jsonResponse, summary, TOKEN } from './helpers/cloudConnectorsFixtures';

const slackSummary = (settings: unknown) => summary({
  connectorId: 'conn-slack',
  provider: 'slack',
  readScopes: ['channels:history', 'groups:history', 'channels:read', 'groups:read'],
  settings,
});

test('chosen channels come from settings with or without names', () => {
  assert.deepEqual(chosenChannelsFromSettings({ channels: ['C1', 'G2'], channelNames: { C1: 'general' } }), [
    { id: 'C1', name: 'general' },
    { id: 'G2', name: null },
  ]);
  assert.deepEqual(chosenChannelsFromSettings({ channels: ['C1'] }), [{ id: 'C1', name: null }]);
  assert.deepEqual(chosenChannelsFromSettings(undefined), []);
  assert.deepEqual(chosenChannelsFromSettings({ channels: 'C1' }), []);
  assert.deepEqual(connectorStateFromSummary('slack', slackSummary({ channels: ['C1'] })).channels, [{ id: 'C1', name: null }]);
  assert.equal(connectorStateFromSummary('github', summary()).channels, undefined);
});

test('choices merge, filter, and toggle in chosen order', () => {
  const options = [
    { id: 'C1', name: 'general', isPrivate: false },
    { id: 'G2', name: 'launch', isPrivate: true },
  ];
  const chosen = [{ id: 'C9', name: 'old-channel' }];
  const choices = channelChoices(options, chosen);
  assert.deepEqual(choices.map((choice) => choice.id), ['C9', 'C1', 'G2'], 'chosen channels Slack no longer lists stay visible');
  assert.deepEqual(filterChannelChoices(choices, '#LAU').map((choice) => choice.id), ['G2']);
  assert.equal(filterChannelChoices(choices, '  ').length, 3);

  const added = toggleChannel(chosen, options[1], true);
  assert.deepEqual(added, [{ id: 'C9', name: 'old-channel' }, { id: 'G2', name: 'launch' }]);
  assert.deepEqual(toggleChannel(added, { id: 'C9', name: 'old-channel', isPrivate: false }, false), [{ id: 'G2', name: 'launch' }]);
  assert.deepEqual(channelSettings([{ id: 'C1', name: 'general' }, { id: 'G2', name: null }]), {
    channels: ['C1', 'G2'],
    channelNames: { C1: 'general' },
  });
});

test('the cloud client lists and saves Slack channels', async () => {
  let settings: unknown = { channels: [] };
  let saved: unknown = null;
  const fixture = cloudFixture((call) => {
    const path = call.url.replace('http://srv', '');
    const method = call.init?.method ?? 'GET';
    if (path === '/v1/cloud/connectors' && method === 'GET') return jsonResponse(200, { connectors: [slackSummary(settings)] });
    if (path === '/v1/cloud/connectors/conn-slack/settings/options' && method === 'GET') {
      return jsonResponse(200, { channels: [{ id: 'C1', name: 'general', isPrivate: false }, { name: 'no id' }] });
    }
    if (path === '/v1/cloud/connectors/conn-slack/settings' && method === 'PUT') {
      saved = JSON.parse(String(call.init?.body));
      settings = saved;
      return jsonResponse(200, { connector: slackSummary(settings) });
    }
    return undefined;
  });
  const client = createCloudConnectorsClient({ accountId: ACCOUNT_ID, http: fixture.http, loadToken: async () => TOKEN });
  await client.list();
  assert.ok(client.listChannels && client.saveChannels);
  assert.deepEqual(await client.listChannels('slack'), [{ id: 'C1', name: 'general', isPrivate: false }]);
  const state = await client.saveChannels('slack', [{ id: 'C1', name: 'general' }]);
  assert.deepEqual(saved, { channels: ['C1'], channelNames: { C1: 'general' } });
  assert.deepEqual(state.channels, [{ id: 'C1', name: 'general' }]);
});

test('a connection without the list scopes asks for a reconnect', async () => {
  const fixture = cloudFixture((call) => {
    const path = call.url.replace('http://srv', '');
    if (path === '/v1/cloud/connectors') return jsonResponse(200, { connectors: [slackSummary({ channels: [] })] });
    if (path === '/v1/cloud/connectors/conn-slack/settings/options') {
      return jsonResponse(409, { errorCode: 'connector_scope_missing', message: 'Reconnect Slack to choose channels.' });
    }
    return undefined;
  });
  const client = createCloudConnectorsClient({ accountId: ACCOUNT_ID, http: fixture.http, loadToken: async () => TOKEN });
  await client.list();
  await assert.rejects(client.listChannels!('slack'), (error: unknown) => {
    assert.ok(isConnectorNeedsReconnect(error));
    assert.equal((error as Error).message, 'Reconnect Slack to choose channels.');
    return true;
  });
});
