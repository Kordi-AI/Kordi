// The Slack Channels section in the connector detail: the searchable list,
// saving a choice, and the reconnect prompt for older connections. Each file
// runs in its own process, so the first dynamic import of react-dom/client
// happens with the DOM installed.

import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { ConnectorsSettingsPanel } from '../src/features/connectors/ConnectorsSettingsPanel';
import { createPreviewConnectorsClient, type ConnectorsClient } from '../src/features/connectors/connectorsClient';
import { ConnectorNeedsReconnectError } from '../src/features/connectors/connectorsErrors';
import type { ConnectorChannel, ConnectorChannelOption, ConnectorState } from '../src/features/connectors/connectorsModel';
import { buttonByText, click, flush, installDom } from './helpers/connectorsPanelDom';

const OPTIONS: ConnectorChannelOption[] = [
  { id: 'C1', name: 'general', isPrivate: false },
  { id: 'G2', name: 'launch', isPrivate: true },
  { id: 'C3', name: 'random', isPrivate: false },
];

function slackClient(listChannels: () => Promise<ConnectorChannelOption[]>) {
  const preview = createPreviewConnectorsClient({ latencyMs: 0 });
  let slack: ConnectorState | null = null;
  const saves: ConnectorChannel[][] = [];
  const client: ConnectorsClient = {
    ...preview,
    async list() {
      const listed = await preview.list();
      const states = listed.states.map((state) => (state.providerId === 'slack'
        ? (slack ??= { ...state, status: 'connected', channels: [{ id: 'C1', name: 'general' }] })
        : state));
      return { ...listed, states };
    },
    listChannels: async () => listChannels(),
    async saveChannels(_providerId, channels) {
      saves.push(channels);
      slack = { ...(slack as ConnectorState), channels };
      return slack;
    },
  };
  return { client, saves };
}

async function openSlack(client: ConnectorsClient) {
  const installed = installDom();
  // Loaded after the DOM exists, so React registers native input events.
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<ConnectorsSettingsPanel accountId="account-1" client={client} isNativeShell={false} />);
  });
  await flush();
  await click(host.querySelector('[data-connector-row="slack"] button'), installed.dom.window);
  await flush();
  return { installed, host, root };
}

function checkbox(host: HTMLElement, id: string): HTMLInputElement | null {
  return host.querySelector<HTMLInputElement>(`[data-channel-id="${id}"] input[type="checkbox"]`);
}

test('the Channels section lists, searches, and saves Slack channels', async () => {
  const { client, saves } = slackClient(async () => OPTIONS);
  const { installed, host, root } = await openSlack(client);
  try {
    const heading = Array.from(host.querySelectorAll('h2')).find((node) => node.textContent === 'Channels');
    assert.ok(heading, 'the section uses a sentence-case heading');
    assert.equal(checkbox(host, 'C1')?.checked, true);
    assert.equal(checkbox(host, 'G2')?.checked, false);
    assert.ok(host.querySelector('[data-channel-id="G2"] [aria-label="Private"]'));

    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search channels"]');
    assert.ok(search);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(installed.dom.window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, 'lau');
      search.dispatchEvent(new installed.dom.window.Event('input', { bubbles: true }));
    });
    await flush();
    assert.equal(checkbox(host, 'C1'), null, 'search hides other channels');
    await click(checkbox(host, 'G2'), installed.dom.window);
    assert.deepEqual(saves, [[{ id: 'C1', name: 'general' }, { id: 'G2', name: 'launch' }]]);
    assert.equal(checkbox(host, 'G2')?.checked, true);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

test('an older Slack connection shows the reconnect prompt', async () => {
  const { client } = slackClient(async () => {
    throw new ConnectorNeedsReconnectError('Reconnect Slack to choose channels.');
  });
  const { installed, host, root } = await openSlack(client);
  try {
    assert.match(host.textContent ?? '', /Reconnect Slack to choose channels\./);
    assert.equal(host.querySelector('input[aria-label="Search channels"]'), null);
    await click(buttonByText(host, 'Reconnect'), installed.dom.window);
    assert.ok(buttonByText(document.body, 'Continue to Slack'), 'Reconnect opens the Slack sign-in dialog');
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

test('other connectors and clients without channel choices show no Channels section', async () => {
  const preview = createPreviewConnectorsClient({ latencyMs: 0 });
  const { installed, host, root } = await openSlack(preview);
  try {
    assert.doesNotMatch(host.textContent ?? '', /Search channels|Loading channels/);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});
