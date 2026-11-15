import assert from 'node:assert/strict';
import test from 'node:test';
import type { CloudAuthClient } from '../src/features/cloud/authClient';
import type { DesktopChatMessageRoute } from '../src/lib/desktop';
import type { DesktopChatContextMessage } from '../src/lib/desktopChatContextTypes';
import type { ComposerProviderOption } from '../src/kordi-app/components';
import { factoryBuildRoute, runFactoryBuildTurn } from '../src/kordi-app/agents/factoryBuildRun';

const route: DesktopChatMessageRoute = { model: 'openai/gpt-6-luna', thinking: 'low', authProvider: 'openai', authChoice: null };
const hostedRoute: DesktopChatMessageRoute = { ...route, authProvider: 'openai-codex', authChoice: 'cloud-login:synthetic-owner' };
const option = (providerId: string, choice: string, extra: Partial<ComposerProviderOption> = {}) => ({
  providerId, value: `${providerId}::${choice}`, label: 'Synthetic account', ...extra,
}) as ComposerProviderOption;
const noFallback = () => { assert.fail('Must not use the Kordi Cloud fallback'); return null; };

test('an explicit account choice is kept', () => {
  const explicit = { ...route, authChoice: 'profile:synthetic-local' };
  assert.equal(factoryBuildRoute(explicit, [option('openai-codex', 'cloud-login:abc', { hosted: true, active: true })], noFallback), explicit);
  assert.equal(factoryBuildRoute(null, [], noFallback), null);
});

test('a route without an account takes the provider only account, else its active one', () => {
  assert.deepEqual(factoryBuildRoute(route, [
    option('anthropic', 'cloud-login:other', { hosted: true, active: true }),
    option('openai-codex', 'cloud-login:abc', { hosted: true }),
  ], noFallback), { ...route, authProvider: 'openai-codex', authChoice: 'cloud-login:abc' });
  assert.deepEqual(factoryBuildRoute({ ...route, authProvider: null }, [
    option('openai-codex', 'profile:one'),
    option('openai-codex', 'cloud-login:two', { hosted: true, active: true }),
    option('openai-codex', 'cloud-login:three', { hosted: true, disabled: true }),
  ], noFallback), { ...route, authProvider: 'openai-codex', authChoice: 'cloud-login:two' });
});

test('several local accounts with none active leave the choice to this Mac', () => {
  const options = [option('openai-codex', 'profile:one'), option('openai-codex', 'profile:two')];
  assert.equal(factoryBuildRoute(route, options, noFallback), route);
});

test('a provider without a usable account falls back to a Kordi Cloud account', () => {
  const cloud: DesktopChatMessageRoute = { model: route.model, thinking: 'low', authProvider: 'openai-codex', authChoice: 'cloud-login:fallback' };
  const selections: unknown[] = [];
  const fallback = (selection: { model: string; thinking?: string | null }) => { selections.push(selection); return cloud; };
  assert.equal(factoryBuildRoute(route, [
    option('anthropic', 'cloud-login:other', { hosted: true, active: true }),
    option('openai-codex', 'cloud-login:gone', { hosted: true, unavailable: true }),
  ], fallback), cloud);
  assert.deepEqual(selections, [{ model: route.model, thinking: 'low' }]);
  assert.equal(factoryBuildRoute(route, [], () => null), route);
});

function fixture() {
  const calls: Array<{ token: string; path: string; body: unknown }> = [];
  const client = {
    async desktopAgentExecution(token: string, path: string, body: unknown) {
      calls.push({ token, path, body });
      return path === 'tasks' ? { acquired: true, runId: 'factory_synthetic' } : {};
    },
  } as Pick<CloudAuthClient, 'desktopAgentExecution'>;
  return { client, calls, session: async () => ({ token: 'synthetic-session', accountId: 'synthetic-account' }) };
}

test('a local route runs without a claim or context messages', async () => {
  const fx = fixture();
  const turn = await runFactoryBuildTurn({ ...fx, route: { ...route, authChoice: 'profile:synthetic-local' },
    session: async () => { throw new Error('Must not load a session'); },
    run: async (contextMessages) => { assert.deepEqual(contextMessages, []); return { succeeded: true }; },
  });
  assert.deepEqual(turn, { succeeded: true });
  assert.deepEqual(fx.calls, []);
});

test('a hosted route runs under a claimed Factory run and completes it', async () => {
  const fx = fixture();
  let received: DesktopChatContextMessage[] = [];
  await runFactoryBuildTurn({ ...fx, route: hostedRoute, run: async (contextMessages) => {
    received = contextMessages;
    assert.deepEqual(fx.calls.map((call) => call.path), ['tasks']);
    return { succeeded: true };
  } });
  const claim = fx.calls[0].body as { kind: string; runtimeRoute: unknown; claimId: string };
  assert.equal(fx.calls[0].token, 'synthetic-session');
  assert.equal(claim.kind, 'factory_test');
  assert.ok(claim.claimId);
  assert.deepEqual(claim.runtimeRoute, {
    defaultModel: hostedRoute.model, defaultAuthProvider: 'openai-codex', defaultAuthChoice: hostedRoute.authChoice, thinking: 'low',
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].contextRole, 'runtimeIdentity');
  assert.deepEqual(received[0].executionLease, {
    runId: 'factory_synthetic', claimId: claim.claimId, ownerAccountId: 'synthetic-account', sessionId: 'factory:synthetic-account',
  });
  assert.deepEqual(fx.calls.map((call) => call.path), ['tasks', 'factory_synthetic/complete']);
  assert.deepEqual(fx.calls[1].body, { claimId: claim.claimId });
});

test('a failed or thrown hosted turn releases its Factory run', async () => {
  const failed = fixture();
  assert.deepEqual(await runFactoryBuildTurn({ ...failed, route: hostedRoute, run: async () => ({ succeeded: false }) }), { succeeded: false });
  assert.deepEqual(failed.calls.map((call) => call.path), ['tasks', 'factory_synthetic/release']);
  const thrown = fixture();
  await assert.rejects(runFactoryBuildTurn({ ...thrown, route: hostedRoute, run: async () => { throw new Error('Synthetic failure'); } }), /Synthetic failure/);
  assert.deepEqual(thrown.calls.map((call) => call.path), ['tasks', 'factory_synthetic/release']);
});

test('missing sign-in and a refused claim never start the turn', async () => {
  const fx = fixture();
  const run = async () => { assert.fail('The turn must not start'); return { succeeded: true }; };
  await assert.rejects(runFactoryBuildTurn({ ...fx, route: hostedRoute, run, session: async () => null }), /Sign in to Kordi/);
  assert.deepEqual(fx.calls, []);
  const client = { desktopAgentExecution: async () => ({ acquired: false, message: 'A Factory run is already active.' }) } as Pick<CloudAuthClient, 'desktopAgentExecution'>;
  await assert.rejects(runFactoryBuildTurn({ ...fx, route: hostedRoute, run, client }), /already active/);
});
