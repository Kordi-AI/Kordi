import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';

import type { CloudProviderAuthSnapshot } from '../src/features/cloud/cloudAgentRuntimeTypes';
import {
  createCloudProviderLoginClient,
  providerLoginErrorFromResponse,
  type ProviderLoginClient,
  type ProviderLoginStartInput,
} from '../src/features/cloud/providerLogin';
import { createAuthSnapshotState } from '../src/kordi-app/auth/authSnapshotState';
import { AuthProviderDetail } from '../src/kordi-app/auth/AuthProviderDetail';
import { renewableAuthChoice, type AuthAddRoute } from '../src/kordi-app/auth/authAddMethods';
import { buildOmpDisplayProviders, loadPinnedOmpCatalog, type DisplayAuthSnapshot } from '../src/kordi-app/auth/ompCatalog';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { waitForReactCondition } from './helpers/waitForReactCondition';

const WORK = 'cloud-login:00000000-0000-4000-8000-000000000001';
const catalog = await loadPinnedOmpCatalog();

function hosted(authChoice: string, label: string, status?: string): CloudProviderAuthSnapshot {
  return {
    snapshotId: `snap_${authChoice.replace(/\W/g, '').slice(-6)}`, provider: 'anthropic', authChoice, label,
    modelHint: null, createdAt: '2026-11-08T00:00:00Z', revokedAt: null, ...(status ? { status } : {}),
  } as CloudProviderAuthSnapshot;
}

function anthropic(snapshots: CloudProviderAuthSnapshot[]) {
  const { providers } = buildOmpDisplayProviders({ authPath: '', hasAnyAuth: true, providers: [] }, snapshots, catalog.providers);
  const provider = providers.find((item) => item.id === 'anthropic');
  assert.ok(provider, 'anthropic is missing from the display providers');
  return provider;
}

test('only accounts a hosted login saved are renewed by one', () => {
  assert.equal(renewableAuthChoice(WORK), WORK);
  assert.equal(renewableAuthChoice('cloud-login:'), null);
  assert.equal(renewableAuthChoice('profile:work'), null);
  assert.equal(renewableAuthChoice('local-active-oauth'), null);
});

test('the login client sends the account a reconnect renews', async () => {
  const bodies: unknown[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ sessionId: 'login_1', status: 'running', step: null, auth: null, version: 1 }), { status: 202 });
  };
  const client = createCloudProviderLoginClient({ baseUrl: () => 'http://127.0.0.1:9', fetchImpl, token: async () => 'synthetic' });
  await client.start({ provider: 'anthropic', label: 'Work', renewAuthChoice: WORK });
  assert.deepEqual(bodies, [{ provider: 'anthropic', label: 'Work', renewAuthChoice: WORK }]);
  const removed = providerLoginErrorFromResponse(409, { errorCode: 'login_account_not_found' });
  assert.equal(removed.code, 'login_account_not_found');
  assert.equal(removed.message, 'This account is no longer saved. Add it again.');
});

test('a renewed sign-in replaces its expired copy instead of listing it twice', async () => {
  const published: DisplayAuthSnapshot[][] = [];
  const state = createAuthSnapshotState((snapshots) => published.push(snapshots));
  const expired = { ...hosted(WORK, 'Work', 'needs-reconnect'), loginMethod: 'sign-in' as const };
  const personal = { ...hosted('cloud-login:00000000-0000-4000-8000-000000000002', 'Personal'), loginMethod: 'sign-in' as const };
  await state.refresh(async () => [expired, personal]);
  state.complete({ ...hosted(WORK, 'Work'), snapshotId: 'snap_renewed', loginMethod: 'sign-in' });
  assert.deepEqual(state.current().map((item) => [item.snapshotId, item.authChoice, item.status ?? 'ready']), [
    [personal.snapshotId, personal.authChoice, 'ready'],
    ['snap_renewed', WORK, 'ready'],
  ]);
  assert.equal(published.at(-1), state.current());
});

test('Reconnect renews the expired hosted sign-in under its own name', async () => {
  const provider = anthropic([hosted(WORK, 'Work', 'needs-reconnect')]);
  const starts: ProviderLoginStartInput[] = [];
  const client: ProviderLoginClient = {
    async start(input) {
      starts.push(input);
      return { sessionId: 'login_1', status: 'running', step: { type: 'progress', message: 'Waiting.' }, auth: null, version: 1 };
    },
    poll: () => new Promise(() => undefined),
    async submit() { return null; },
    async cancel() { return null; },
  };
  await withJsdomRoot(async (mount, root) => {
    let route: AuthAddRoute | null = null;
    const render = () => (
      <AuthProviderDetail
        provider={provider}
        rawProviders={[]}
        error={null}
        onOpenLogin={() => undefined}
        onSelectAuthChoice={() => undefined}
        onRemoveAuthProfile={() => undefined}
        onLogoutProvider={() => undefined}
        onRefreshAuth={() => undefined}
        loginClient={client}
        needsReconnect={[WORK]}
        addRoute={route}
        onAddRouteChange={(next) => { route = next; void act(async () => { root.render(render()); }); }}
      />
    );
    const host = await mount(render());
    const reconnect = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Reconnect');
    assert.ok(reconnect, 'the expired account offers Reconnect');
    await act(async () => { reconnect.click(); });
    assert.equal((route as AuthAddRoute | null)?.renew, WORK);

    await waitForReactCondition(() => Boolean(host.querySelector('input[aria-label="Account name"]')), 'the login page loads');
    const name = host.querySelector<HTMLInputElement>('input[aria-label="Account name"]');
    assert.equal(name?.value, 'Work');
    assert.equal(name?.disabled, true);
    const begin = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Sign in');
    assert.ok(begin, `the login page offers Sign in: ${host.textContent}`);
    await act(async () => { begin.click(); });
    await waitForReactCondition(() => starts.length === 1, 'the reconnect starts a login');
    assert.equal(starts[0].provider, 'anthropic');
    assert.equal(starts[0].label, 'Work');
    assert.equal(starts[0].renewAuthChoice, WORK);
  });
});
