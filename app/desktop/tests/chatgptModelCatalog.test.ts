import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hostedModelOptions, hostedRouteAccounts, hostedRouteForChoice } from '../src/features/chat/hostedComposerOptions';
import {
  CHATGPT_DEFAULT_MODEL, CHATGPT_MODEL_ORDER, isOfferedChatGptModel, orderChatGptModels, withChatGptModelCatalog,
} from '../src/features/cloud/chatgptModelCatalog';
import { withOfferedModelOptions } from '../src/features/cloud/providerModels';
import { catalogModelThinkingLevels } from '../src/features/cloud/modelThinkingLevels';
import { loadPinnedOmpCatalog, refreshOmpCatalog } from '../src/kordi-app/auth/ompCatalog';
import { modelDisplayName, modelShortName } from '../src/lib/modelDisplayName';

const offered = [
  'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra',
  'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
];

test('Kordi offers exactly ten ChatGPT models, newest first, with GPT-6.2 Sol as the default', () => {
  assert.deepEqual([...CHATGPT_MODEL_ORDER], offered);
  assert.equal(CHATGPT_DEFAULT_MODEL, 'gpt-6.2-sol');
  for (const model of offered) assert.equal(isOfferedChatGptModel(model), true, model);
  for (const model of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-5.6', 'gpt-5.6-sol-pro', 'gpt-daybreak-blue-latest', '']) {
    assert.equal(isOfferedChatGptModel(model), false, model);
  }
});

test('ordering ChatGPT models keeps only the offered ones, in picker order', () => {
  assert.deepEqual(
    orderChatGptModels(['gpt-5.5', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-daybreak-blue-latest', 'gpt-6.1-sol', 'gpt-6.2-astra', 'gpt-5.4', 'GPT-6.2-SOL']),
    ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-luna'],
  );
});

test('the pinned ChatGPT and OpenAI catalogs offer exactly the ten models with GPT-6.2 Sol as the default', async () => {
  const catalog = await loadPinnedOmpCatalog();
  for (const id of ['openai-codex', 'openai']) {
    const entry = catalog.providers.find((item) => item.id === id);
    assert.ok(entry, id);
    assert.deepEqual(entry.models, offered, id);
    assert.equal(entry.defaultModel, CHATGPT_DEFAULT_MODEL, id);
  }
});

test('a hosted catalog refresh offers the same ten models whatever the server lists', async () => {
  const pinned = await loadPinnedOmpCatalog();
  const refreshed = await refreshOmpCatalog(pinned, async () => ({
    providers: [{ id: 'openai-codex', models: ['gpt-5.5', 'gpt-6-sol', 'gpt-daybreak-red-latest'], defaultModel: 'gpt-5.5' }],
  }));
  const codex = refreshed.providers.find((entry) => entry.id === 'openai-codex');
  assert.deepEqual(codex?.models, offered);
  assert.equal(codex?.defaultModel, CHATGPT_DEFAULT_MODEL);
});

test('other providers keep their catalog order', () => {
  const entry = { id: 'anthropic', models: ['claude-b', 'claude-a'], defaultModel: 'claude-a' };
  assert.equal(withChatGptModelCatalog(entry), entry);
});

test('a hosted ChatGPT account lists only the ten models and opens with the default when its stored model is not offered', async () => {
  const { providers: catalog } = await loadPinnedOmpCatalog();
  const base = { authChoice: 'cloud-login:chatgpt', label: 'Work', provider: 'openai-codex', needsReconnect: false };
  for (const stored of ['gpt-5.5', 'gpt-5.4', 'gpt-daybreak-blue-latest']) {
    const [account] = hostedRouteAccounts([{ ...base, model: stored }], catalog);
    assert.equal(account.model, null, stored);
    assert.deepEqual(account.models, offered, stored);
    assert.equal(hostedRouteForChoice(account, { catalog })?.model, `openai-codex/${CHATGPT_DEFAULT_MODEL}`, stored);
  }
  const [kept] = hostedRouteAccounts([{ ...base, model: 'gpt-6-luna' }], catalog);
  assert.equal(kept.model, 'gpt-6-luna');
  assert.equal(hostedRouteForChoice(kept, { catalog })?.model, 'openai-codex/gpt-6-luna');
  const [apiKey] = hostedRouteAccounts([{ ...base, authChoice: 'cloud-api-key:openai', provider: 'openai', model: 'gpt-4.1' }], catalog);
  assert.deepEqual(hostedModelOptions([apiKey], catalog).map((option) => option.value), offered.map((model) => `openai/${model}`));
});

test('this Mac\'s ChatGPT and OpenAI models are limited to the ten, in picker order, while other providers keep their place', () => {
  const options = [
    { value: 'google/gemini-3.1-pro-preview', provider: 'google' },
    { value: 'openai/gpt-5.5', provider: 'openai' },
    { value: 'openai/gpt-5.6-sol', provider: 'openai' },
    { value: 'openai/gpt-6.2-sol', provider: 'openai' },
    { value: 'lm-studio/qwen3', provider: 'lm-studio' },
    { value: 'openai-codex/gpt-6-luna', provider: 'openai-codex' },
    { value: 'openai-codex/gpt-6.2-astra', provider: 'openai-codex' },
    { value: 'openai/gpt-4o', provider: 'openai' },
  ];
  assert.deepEqual(withOfferedModelOptions(options).map((option) => option.value), [
    'google/gemini-3.1-pro-preview',
    'openai/gpt-6.2-sol',
    'openai/gpt-5.6-sol',
    'lm-studio/qwen3',
    'openai-codex/gpt-6.2-astra',
    'openai-codex/gpt-6-luna',
  ]);
});

test('the three newest ChatGPT models read like their siblings', () => {
  const names = {
    'gpt-6.2-sol': ['GPT-6.2 Sol', '6.2 Sol'],
    'gpt-6.2-astra': ['GPT-6.2 Astra', '6.2 Astra'],
    'gpt-6.1-terra': ['GPT-6.1 Terra', '6.1 Terra'],
    'gpt-6.1-sol': ['GPT-6.1 Sol', '6.1 Sol'],
  };
  for (const [model, [name, short]] of Object.entries(names)) {
    assert.equal(modelDisplayName(`openai-codex/${model}`), name);
    assert.equal(modelDisplayName(`openai-codex/${model}`, model), name);
    assert.equal(modelShortName(`openai-codex/${model}`), short);
  }
});

test('every offered ChatGPT model carries the full OMP effort list, the newest ones included', async () => {
  const { providers } = await loadPinnedOmpCatalog();
  const full = ['low', 'medium', 'high', 'xhigh', 'max'];
  for (const provider of ['openai-codex', 'openai', 'codex']) {
    for (const model of offered) assert.deepEqual(catalogModelThinkingLevels(providers, provider, model), full, `${provider}/${model}`);
  }
  // Without the OpenAI API entry, GPT-6.1 Terra still uses its tier's efforts.
  const codexOnly = providers.filter((entry) => entry.id === 'openai-codex');
  assert.deepEqual(catalogModelThinkingLevels(codexOnly, 'openai-codex', 'gpt-6.1-terra'), full);
  const [account] = hostedRouteAccounts([{ authChoice: 'cloud-login:chatgpt', label: 'Work', provider: 'openai-codex', needsReconnect: false, model: null }], providers);
  for (const option of hostedModelOptions([account], providers)) assert.deepEqual(option.thinkingLevels, full, option.value);
});

test('the pinned catalog carries OMP thinking levels per model, across ChatGPT provider ids', async () => {
  const { providers } = await loadPinnedOmpCatalog();
  const full = ['low', 'medium', 'high', 'xhigh', 'max'];
  assert.deepEqual(catalogModelThinkingLevels(providers, 'openai-codex', 'gpt-5.5'), ['low', 'medium', 'high', 'xhigh']);
  for (const model of ['claude-fable-5-1', 'claude-sonnet-5', 'claude-opus-4-8']) {
    assert.deepEqual(catalogModelThinkingLevels(providers, 'anthropic', model), full, model);
  }
  assert.deepEqual(catalogModelThinkingLevels(providers, 'anthropic', 'claude-haiku-4-5'), ['minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(catalogModelThinkingLevels(providers, 'openai-codex', 'not-a-model'), null);
  assert.equal(catalogModelThinkingLevels(providers, 'unknown-provider', 'gpt-6-sol'), null);
  assert.equal(catalogModelThinkingLevels([], 'openai-codex', 'gpt-6-sol'), null);
});

test('a hosted catalog refresh keeps the pinned thinking levels', async () => {
  const pinned = await loadPinnedOmpCatalog();
  const refreshed = await refreshOmpCatalog(pinned, async () => ({
    providers: [{ id: 'openai-codex', models: ['gpt-6-sol'], modelThinking: { 'gpt-6-sol': 'p1' } as never }],
  }));
  assert.deepEqual(catalogModelThinkingLevels(refreshed.providers, 'openai-codex', 'gpt-6-sol'), ['low', 'medium', 'high', 'xhigh', 'max']);
});
