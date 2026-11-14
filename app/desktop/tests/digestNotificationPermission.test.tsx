import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { digestClient } from '../src/features/digest/client';
import DigestPage from '../src/features/digest/DigestPage';
import { NOTIFICATION_SETTINGS_URL } from '../src/features/digest/reminderPermission';
import { resetNotificationRequestStallForTests } from '../src/features/notifications/notificationRequestStall';
import type { DigestResponse } from '../src/features/digest/types';

type Call = { command: string; args?: Record<string, unknown> };

function digest(accountId: string): DigestResponse {
  return {
    accountId, status: 'ready', errorCode: null, errorProvider: null,
    revision: 1, updatedAt: '2026-11-13T16:00:00Z', partial: false, feedback: [], sources: [],
    snapshot: { claims: [], commitments: [], suggestions: [], calendarCandidates: [] },
  } as DigestResponse;
}

/** Renders the Digest page with a native shell whose notification status follows `status`. */
async function withDigest(accountId: string, status: { read: string; afterRequest: string }, run: (page: { host: HTMLElement; calls: Call[]; dom: JSDOM; until: (ready: () => boolean) => Promise<void> }) => Promise<void>) {
  resetNotificationRequestStallForTests();
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const calls: Call[] = [];
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    await new Promise(resolve => setTimeout(resolve, 1));
    if (command === 'desktop_digest_reminders') {
      if (args?.requestPermission) status.read = status.afterRequest;
      return status.read;
    }
    if (command === 'desktop_open_external_url') return 'opened';
    throw new Error('Unavailable in this test.');
  } } });
  const original = { ...digestClient };
  digestClient.read = async () => digest(accountId);
  digestClient.calendar = async () => ({ events: [] });
  const host = document.getElementById('root')!, root = createRoot(host);
  // Native IPC and page reads finish outside act; wait for the expected state instead of a fixed delay.
  const until = async (ready: () => boolean) => {
    for (let attempt = 0; attempt < 300 && !ready(); attempt += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  };
  try {
    await act(async () => root.render(createElement(DigestPage, { accountId, onOpenProviderSettings: () => {} })));
    await until(() => reads(calls) > 0 && !!host.querySelector('.digest-notices button'));
    await run({ host, calls, dom, until });
  } finally {
    await act(async () => root.unmount());
    Object.assign(digestClient, original); Object.assign(globalThis, previous); dom.window.close();
    resetNotificationRequestStallForTests();
  }
}

const notice = (host: HTMLElement) => host.querySelector('.digest-notices')!.textContent!;
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll('.digest-notices button')].find(item => item.textContent === label) as HTMLButtonElement | undefined;
const reads = (calls: Call[]) => calls.filter(call => call.command === 'desktop_digest_reminders').length;
const requests = (calls: Call[]) => calls.filter(call => call.command === 'desktop_digest_reminders' && call.args?.requestPermission === true).length;

test('notifications that were never asked offer Allow, and only the click asks macOS', async () => {
  await withDigest('reminders-allow', { read: 'default', afterRequest: 'granted' }, async ({ host, calls, until }) => {
    assert.match(notice(host), /^Notifications are off\.\s*·?\s*Allow$/);
    assert.equal(requests(calls), 0, 'loading the page must not ask macOS');
    await act(async () => button(host, 'Allow')!.click());
    await until(() => !/Notifications are off/.test(notice(host)));
    assert.equal(requests(calls), 1);
    assert.doesNotMatch(notice(host), /Notifications are off/);
  });
});

test('a request macOS leaves unanswered switches to System Settings instead of asking again', async () => {
  await withDigest('reminders-stalled', { read: 'default', afterRequest: 'default' }, async ({ host, calls, dom, until }) => {
    await act(async () => button(host, 'Allow')!.click());
    await until(() => !!button(host, 'Open System Settings'));
    assert.equal(requests(calls), 1);
    assert.equal(button(host, 'Allow'), undefined);
    const before = reads(calls);
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event('focus')); });
    await until(() => reads(calls) > before);
    assert.equal(requests(calls), 1, 'focus re-checks never ask macOS');
    assert.equal(button(host, 'Allow'), undefined);
    await act(async () => button(host, 'Open System Settings')!.click());
    await until(() => calls.some(call => call.command === 'desktop_open_external_url'));
    assert.deepEqual(calls.filter(call => call.command === 'desktop_open_external_url').map(call => call.args?.url), [NOTIFICATION_SETTINGS_URL]);
  });
});

test('turned-off notifications open System Settings, and returning to the window clears the line once they are on', async () => {
  const status = { read: 'denied', afterRequest: 'denied' };
  await withDigest('reminders-denied', status, async ({ host, calls, dom, until }) => {
    assert.match(notice(host), /^Notifications are off\.\s*·?\s*Open System Settings$/);
    assert.equal(button(host, 'Allow'), undefined);
    status.read = 'granted';
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event('focus')); });
    await until(() => !/Notifications are off/.test(notice(host)));
    assert.doesNotMatch(notice(host), /Notifications are off/);
    assert.equal(requests(calls), 0);
  });
});
