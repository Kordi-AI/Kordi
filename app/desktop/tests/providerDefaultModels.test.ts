import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { resolveDefaultCloudAgentRuntimeRoute } from '../src/app/useKordiDefaultCloudAgentRuntimeRoute';
import { hostedAuthOptions, hostedModelOptions, hostedRouteAccounts, hostedRouteForChoice } from '../src/features/chat/hostedComposerOptions';
import { preferredModelValueForProviderFromOptions } from '../src/features/chat/useComposerViewModel';
import type { HostedAccount } from '../src/features/cloud/hostedAccounts';
import { catalogModelThinkingLevels } from '../src/features/cloud/modelThinkingLevels';
import { providerDefaultModel, withProviderDefaultModels } from '../src/features/cloud/providerModels';
import { loadPinnedOmpCatalog, type OmpCatalogEntry } from '../src/kordi-app/auth/ompCatalog';
import { defaultComposerModelOption } from '../src/kordi-app/components/composerModelSelection';
import { fallbackComposerThinkingValue } from '../src/kordi-app/components/composerThinking';
import { modelDisplayName, modelEffortLabel } from '../src/lib/modelDisplayName';

type PinnedEntry = { id: string; models: string[]; defaultModel?: string | null };
const pinned = JSON.parse(readFileSync(new URL('../../../shared/omp-catalog/omp-provider-catalog.json', import.meta.url), 'utf8')) as { providers: PinnedEntry[] };
const { providers: catalog } = await loadPinnedOmpCatalog();

/** The rule, restated: Kordi's default for ChatGPT, OpenAI and Claude, else the catalog default it lists (any case), else the first model. */
function expectedDefault(providerId: string, listed: string[], catalogDefault: string | null | undefined) {
  const kordi = providerId === 'openai' || providerId === 'openai-codex' ? 'gpt-6.2-sol' : providerId === 'anthropic' ? 'claude-sonnet-5-5' : null;
  const match = (model: string | null | undefined) => (model ? listed.find((item) => item.toLowerCase() === model.toLowerCase()) : undefined);
  return match(kordi) ?? match(catalogDefault) ?? listed[0] ?? null;
}

function hostedAccount(providerId: string, model: string | null = null): HostedAccount {
  const authChoice = providerId === 'openai-codex' ? `cloud-login:${providerId}` : `cloud-api-key:${providerId}`;
  return { authChoice, label: providerId, provider: providerId, model, needsReconnect: false };
}

/** The composer's view of these hosted accounts in the browser, as the app builds it. */
function browserComposer(accounts: HostedAccount[], catalogEntries: OmpCatalogEntry[] = catalog, activeChoice: string | null = null) {
  const routeAccounts = hostedRouteAccounts(accounts, catalogEntries, new Set());
  const options = withProviderDefaultModels(
    hostedModelOptions(routeAccounts, catalogEntries).map((option) => ({ ...option, label: modelDisplayName(option.value, option.label) })),
    catalogEntries,
  );
  const preferred = (providerId: string) => preferredModelValueForProviderFromOptions(providerId, options, []);
  const route = resolveDefaultCloudAgentRuntimeRoute({
    activeLoginProviderId: null, authOptions: hostedAuthOptions(routeAccounts, activeChoice), chatModelOptions: options,
    desktopAuthState: null, isNativeShell: false, browserApp: true, preferredModelValueForProvider: preferred,
    resolveComposerProviderId: () => 'openai', selectedModel: '', selectedThinking: 'default',
  });
  return { routeAccounts, options, preferred, route };
}

test('every pinned provider opens a fresh hosted account on its default model, by one rule, on every default path', () => {
  let checked = 0;
  for (const entry of pinned.providers) {
    if (entry.id === 'custom') continue;
    const { routeAccounts: [account], options, preferred, route } = browserComposer([hostedAccount(entry.id)]);
    assert.ok(account, entry.id);
    const expected = expectedDefault(account.providerId, account.models, entry.defaultModel);
    if (!expected) {
      assert.equal(route, null, `${entry.id} lists no models, so nothing opens`);
      continue;
    }
    const value = `${account.providerId}/${expected}`;
    assert.equal(route?.model, value, `${entry.id}: browser default route`);
    assert.equal(route?.authProvider, account.providerId, `${entry.id}: its own account`);
    assert.equal(route?.thinking, 'default', `${entry.id}: the model's own effort`);
    assert.equal(preferred(account.providerId), value, `${entry.id}: composer preferred model`);
    assert.equal(defaultComposerModelOption(account.providerId, options)?.value, value, `${entry.id}: picker Default row`);
    assert.equal(hostedRouteForChoice(account, { catalog })?.model, value, `${entry.id}: choosing the account`);
    assert.doesNotMatch(value, /(^|\/)gpt-5\.4$/i, `${entry.id}: never the old GPT-5.4 placeholder`);
    checked += 1;
  }
  assert.ok(checked >= 70, `checked ${checked} providers`);
});

test('the default follows the catalog where the first listed model differs', () => {
  const opened = (providerId: string) => browserComposer([hostedAccount(providerId)]).route?.model;
  assert.equal(opened('google'), 'google/gemini-3.1-pro-preview');
  assert.equal(opened('xai'), 'xai/grok-4.6');
  assert.equal(opened('deepseek'), 'deepseek/deepseek-v4-pro');
  assert.equal(opened('moonshot'), 'moonshot/kimi-k2.7-code');
  assert.equal(opened('zai'), 'zai/glm-5.3');
  assert.equal(opened('openai-codex'), 'openai-codex/gpt-6.2-sol');
  assert.equal(opened('anthropic'), 'anthropic/claude-sonnet-5-5');
  // Catalog oddities: no default, a default it does not list, and no models.
  assert.equal(opened('minimax-cn'), 'minimax-cn/MiniMax-M2');
  assert.equal(opened('baseten'), 'baseten/deepseek-ai/DeepSeek-V4-Flash-0731');
  assert.equal(opened('cloudflare-workers-ai'), undefined);
});

test('the rule matches a catalog default in any case and returns the listed spelling', () => {
  assert.equal(providerDefaultModel('example', ['model-a', 'Model-B'], 'model-b'), 'Model-B');
  assert.equal(providerDefaultModel('example', ['model-a', 'model-b'], 'not-listed'), 'model-a');
  assert.equal(providerDefaultModel('example', ['model-a'], null), 'model-a');
  assert.equal(providerDefaultModel('example', [], 'model-a'), null);
  assert.equal(providerDefaultModel('openai', ['gpt-5.6-luna', 'gpt-6-sol'], 'gpt-5.6-luna'), 'gpt-6-sol', 'the first of Kordi\'s set it lists');
  assert.equal(providerDefaultModel('anthropic', ['claude-haiku-5-5', 'claude-opus-5-5'], 'claude-haiku-5-5'), 'claude-opus-5-5');
});

test('a stored model the account still lists keeps priority; the Default row stays the provider default', () => {
  const { routeAccounts: [google], options } = browserComposer([hostedAccount('google', 'gemini-2.5-flash')]);
  assert.equal(hostedRouteForChoice(google, { catalog })?.model, 'google/gemini-2.5-flash');
  assert.equal(defaultComposerModelOption('google', options)?.value, 'google/gemini-3.1-pro-preview');
});

test('the initial default effort is valid for every provider default: sent as default, shown as Default', () => {
  for (const entry of pinned.providers) {
    if (entry.id === 'custom') continue;
    const { options, route } = browserComposer([hostedAccount(entry.id)]);
    if (!route?.model) continue;
    const option = options.find((item) => item.value === route.model);
    assert.ok(option, entry.id);
    const efforts = catalogModelThinkingLevels(catalog, route.authProvider ?? entry.id, route.model.slice(route.model.indexOf('/') + 1));
    // A model the catalog gives no effort runs at its own default only.
    assert.deepEqual(option.thinkingLevels, efforts ?? ['off'], `${entry.id}: effort list`);
    assert.equal(route.thinking, 'default', entry.id);
    assert.equal(modelEffortLabel(route.thinking ?? ''), 'Default', entry.id);
    if (!efforts) assert.equal(fallbackComposerThinkingValue(option.thinkingLevels ?? [], 'medium'), 'default', `${entry.id}: no effort to pick`);
  }
});

test('with several hosted accounts the browser opens on the active one, else ChatGPT or OpenAI, else the first listed', () => {
  const claude = hostedAccount('anthropic');
  const google = hostedAccount('google');
  const chatgpt = hostedAccount('openai-codex');
  const opened = (accounts: HostedAccount[], active: string | null = null) => browserComposer(accounts, catalog, active).route;
  assert.equal(opened([claude, google, chatgpt])?.model, 'openai-codex/gpt-6.2-sol');
  assert.equal(opened([claude, google])?.model, 'anthropic/claude-sonnet-5-5');
  assert.equal(opened([google, claude])?.model, 'google/gemini-3.1-pro-preview');
  const active = opened([claude, google, chatgpt], google.authChoice);
  assert.equal(active?.authChoice, google.authChoice);
  assert.equal(active?.model, 'google/gemini-3.1-pro-preview');
  assert.equal(opened([claude, google, chatgpt])?.model, opened([claude, google, chatgpt])?.model, 'the same lists open the same account');
});
