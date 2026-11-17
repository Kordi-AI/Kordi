import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hostedModelOptions, hostedRouteAccounts, hostedRouteForChoice } from '../src/features/chat/hostedComposerOptions';
import { preferredModelValueForProviderFromOptions } from '../src/features/chat/useComposerViewModel';
import {
  CLAUDE_DEFAULT_MODEL, CLAUDE_MODEL_ORDER, isOfferedClaudeModel, orderClaudeModels, withClaudeModelCatalog,
} from '../src/features/cloud/claudeModelCatalog';
import { hostedAccountsFromSnapshots } from '../src/features/cloud/hostedAccounts';
import { catalogModelThinkingLevels } from '../src/features/cloud/modelThinkingLevels';
import { withOfferedModelOptions } from '../src/features/cloud/providerModels';
import { loadPinnedOmpCatalog, refreshOmpCatalog } from '../src/kordi-app/auth/ompCatalog';
import { fallbackComposerThinkingValue } from '../src/kordi-app/components/composerThinking';
import { modelDisplayName, modelShortName } from '../src/lib/modelDisplayName';
import type { CloudProviderAuthSnapshot } from '../src/features/cloud/cloudAgentRuntimeTypes';

const catalog = (await loadPinnedOmpCatalog()).providers;
const claudeSet = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2', 'claude-haiku-5-5'];

function hostedSnapshot(provider: string, authChoice: string, modelHint: string | null): CloudProviderAuthSnapshot {
  return {
    snapshotId: `snap_${provider}`, provider, authChoice, label: provider,
    modelHint, createdAt: '2026-01-01T00:00:00Z', revokedAt: null,
  };
}

const hostedAccount = (provider: string, authChoice: string, modelHint: string | null) => {
  const [account] = hostedRouteAccounts(hostedAccountsFromSnapshots([hostedSnapshot(provider, authChoice, modelHint)]), catalog);
  assert.ok(account);
  return account;
};
const claudeAccount = (modelHint: string | null) => hostedAccount('anthropic', 'cloud-api-key:claude', modelHint);

/** This Mac's model options as the composer labels them, with display names. */
const localOptions = (modelIds: string[]) => modelIds.map((modelId) => {
  const value = `anthropic/${modelId}`;
  return { value, label: modelDisplayName(value, modelId), provider: 'anthropic' };
});

test('Kordi offers exactly the four current Claude models, Sonnet 5.5 first as the default', () => {
  assert.deepEqual([...CLAUDE_MODEL_ORDER], claudeSet);
  assert.equal(CLAUDE_DEFAULT_MODEL, 'claude-sonnet-5-5');
  for (const model of claudeSet) assert.equal(isOfferedClaudeModel(model), true, model);
  for (const model of ['claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5-1', 'claude-mythos-5-2', 'claude-haiku-4-5-20251001', '']) {
    assert.equal(isOfferedClaudeModel(model), false, model);
  }
  assert.deepEqual(orderClaudeModels(['claude-haiku-5-5', 'claude-mythos-5', 'claude-opus-4-8', 'CLAUDE-SONNET-5-5', 'claude-fable-5-2']),
    ['claude-sonnet-5-5', 'claude-fable-5-2', 'claude-haiku-5-5']);
});

test('the pinned and refreshed Anthropic catalogs offer only the four, with Sonnet 5.5 as the default', async () => {
  const anthropic = catalog.find((entry) => entry.id === 'anthropic');
  assert.ok(anthropic);
  assert.deepEqual(anthropic.models, claudeSet);
  assert.equal(anthropic.defaultModel, 'claude-sonnet-5-5');
  const refreshed = await refreshOmpCatalog({ version: null, providers: catalog }, async () => ({
    providers: [{ id: 'anthropic', models: ['claude-opus-5-5', 'claude-opus-4-8', 'claude-mythos-5'], defaultModel: 'claude-opus-5-5' }],
  }));
  assert.deepEqual(refreshed.providers[0]?.models, claudeSet);
  assert.equal(refreshed.providers[0]?.defaultModel, 'claude-sonnet-5-5', 'a hosted catalog refresh keeps the Kordi default');
});

test('Claude through other providers keeps those providers\' lists and defaults', () => {
  for (const id of ['amazon-bedrock', 'google-vertex', 'openrouter', 'github-copilot']) {
    const entry = catalog.find((item) => item.id === id);
    assert.ok(entry, id);
    assert.equal(withClaudeModelCatalog(entry), entry, id);
  }
  const bedrock = { id: 'amazon-bedrock', models: ['claude-sonnet-5-5'], defaultModel: 'us.anthropic.claude-opus-5-5' };
  assert.equal(withClaudeModelCatalog(bedrock), bedrock);
});

test('the four read as Claude names and carry the full OMP effort list', () => {
  const names = { 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-fable-5-2': 'Claude Fable 5.2', 'claude-haiku-5-5': 'Claude Haiku 5.5' };
  for (const [model, name] of Object.entries(names)) {
    assert.equal(modelDisplayName(`anthropic/${model}`), name);
    assert.equal(modelShortName(`anthropic/${model}`), name);
    assert.deepEqual(catalogModelThinkingLevels(catalog, 'anthropic', model), ['low', 'medium', 'high', 'xhigh', 'max'], model);
  }
});

test('a hosted Claude account whose stored model is older opens on Sonnet 5.5 and lists only the four', () => {
  for (const stored of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-mythos-5-2']) {
    const account = claudeAccount(stored);
    assert.equal(account.model, null, stored);
    assert.deepEqual(account.models, claudeSet, stored);
    assert.equal(hostedRouteForChoice(account, { catalog })?.model, 'anthropic/claude-sonnet-5-5', stored);
  }
  const kept = claudeAccount('claude-opus-5-5');
  assert.equal(hostedRouteForChoice(kept, { catalog })?.model, 'anthropic/claude-opus-5-5', 'a stored model in the set keeps priority');
  assert.equal(hostedRouteForChoice(kept, { model: 'anthropic/claude-opus-4-8', catalog })?.model, 'anthropic/claude-opus-5-5', 'an older model is not served');
});

test('a fresh hosted Claude account opens on Sonnet 5.5 and leaves its effort to the runtime', () => {
  const fresh = claudeAccount(null);
  const options = hostedModelOptions([fresh], catalog);
  assert.deepEqual(options.map((option) => option.value), claudeSet.map((model) => `anthropic/${model}`));
  assert.deepEqual(options.filter((option) => option.providerDefault).map((option) => option.value), ['anthropic/claude-sonnet-5-5']);
  assert.deepEqual(hostedRouteForChoice(fresh, { catalog }), {
    model: 'anthropic/claude-sonnet-5-5', authProvider: 'anthropic', authChoice: 'cloud-api-key:claude', thinking: null,
  });
  for (const thinking of ['off', 'default', 'minimal', 'medium', 'xhigh']) {
    assert.equal(hostedRouteForChoice(fresh, { thinking, catalog })?.thinking, thinking, `${thinking} passes through`);
  }
});

test('choosing a hosted account never rewrites the effort, for any provider', () => {
  const cases = [
    { account: hostedAccount('openai-codex', 'cloud-login:chatgpt', 'gpt-6.1-sol'), model: 'openai-codex/gpt-6.1-sol' },
    { account: claudeAccount('claude-opus-5-5'), model: 'anthropic/claude-opus-5-5' },
    { account: hostedAccount('google', 'cloud-api-key:gemini', 'gemini-3.1-pro-preview'), model: 'google/gemini-3.1-pro-preview' },
  ];
  for (const { account, model } of cases) {
    for (const thinking of ['default', 'off', 'minimal', null]) {
      const route = hostedRouteForChoice(account, { thinking, catalog });
      assert.equal(route?.model, model, model);
      assert.equal(route?.thinking, thinking, `${model} keeps ${String(thinking)}`);
      assert.equal(hostedRouteForChoice(account, { model, thinking, catalog })?.thinking, thinking, `${model} chosen by model keeps ${String(thinking)}`);
    }
  }
});

test("this Mac's Claude models are limited to the four, and an older runtime default is never preferred", () => {
  const listed = withOfferedModelOptions(localOptions(['claude-fable-5-1', 'claude-opus-4-8', 'claude-haiku-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5']));
  assert.deepEqual(listed.map((option) => option.value), ['anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5']);
  assert.equal(listed[0]?.label, 'Claude Sonnet 5.5');
  assert.equal(preferredModelValueForProviderFromOptions('anthropic', listed, []), 'anthropic/claude-sonnet-5-5');
  assert.equal(
    preferredModelValueForProviderFromOptions('anthropic', listed, [], { provider: 'anthropic', model: 'claude-opus-4-8' }),
    'anthropic/claude-sonnet-5-5',
    'a saved default Kordi no longer offers gives way to Sonnet 5.5',
  );
  assert.equal(
    preferredModelValueForProviderFromOptions('anthropic', listed, [], { provider: 'anthropic', model: 'claude-haiku-5-5' }),
    'anthropic/claude-haiku-5-5',
    "this Mac's saved default model in the set wins",
  );
  // Without Sonnet 5.5 the first model of the set it lists opens; the previous Sonnet is no longer offered.
  assert.equal(preferredModelValueForProviderFromOptions('anthropic', localOptions(['claude-haiku-5-5', 'claude-fable-5-2']), []), 'anthropic/claude-fable-5-2');
  // Switching this Mac's composer to Sonnet 5.5 moves a level it lacks to Medium.
  const levels = catalogModelThinkingLevels(catalog, 'anthropic', 'claude-sonnet-5-5') ?? [];
  for (const current of ['off', 'default']) assert.equal(fallbackComposerThinkingValue(levels, current), 'medium', current);
});
