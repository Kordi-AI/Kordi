import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHATGPT_DEFAULT_MODEL } from '../src/features/cloud/chatgptModelCatalog';
import * as composerViewModel from '../src/features/chat/useComposerViewModel';

const { preferredModelValueForProviderFromOptions: preferredModel } = composerViewModel;

test('OpenAI auth routes prefer the shared runtime default when Kordi offers it', () => {
  const modelOptions = [
    { value: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna', provider: 'openai' },
    { value: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol', provider: 'openai' },
    { value: 'openai/gpt-6-sol', label: 'GPT-6 Sol', provider: 'openai' },
  ];

  const preferredRuntimeRoute = { provider: 'openai', model: 'gpt-5.6-sol' };
  assert.equal(preferredModel('openai-codex', modelOptions, [], preferredRuntimeRoute), 'openai/gpt-5.6-sol');
  assert.equal(preferredModel('openai', modelOptions, [], preferredRuntimeRoute), 'openai/gpt-5.6-sol');
});

test('an explicit root runtime model matches the exact model id before the ChatGPT order', () => {
  const modelOptions = [
    { value: 'openai/gpt-6.2-sol', label: 'GPT-6.2 Sol', provider: 'openai' },
    { value: 'openai/gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai' },
    { value: 'openai/gpt-6-sol', label: 'GPT-6 Sol', provider: 'openai' },
  ];

  assert.equal(preferredModel('openai', modelOptions, [], { provider: 'openai', model: 'gpt-6-luna' }), 'openai/gpt-6-luna');
});

test('ChatGPT opens on the first offered model in the ChatGPT order, matched by model id', () => {
  // Labels are display names, so a label never decides the preferred model.
  const modelOptions = [
    { value: 'openai-codex/gpt-5.6-sol', label: 'GPT-5.6 Sol', provider: 'openai' },
    { value: 'openai-codex/gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'openai' },
    { value: 'openai-codex/gpt-6.2-sol', label: 'GPT-6.2 Sol', provider: 'openai' },
  ];
  assert.equal(preferredModel('openai-codex', modelOptions, []), `openai-codex/${CHATGPT_DEFAULT_MODEL}`);
  assert.equal(preferredModel('openai-codex', modelOptions.slice(0, 2), []), 'openai-codex/gpt-6.1-sol');
});

test('a runtime default Kordi no longer offers for ChatGPT is never preferred', () => {
  const modelOptions = [
    { value: 'openai/gpt-5.4', label: 'GPT-5.4', provider: 'openai' },
    { value: 'openai/gpt-5.6-terra', label: 'GPT-5.6 Terra', provider: 'openai' },
    { value: 'openai/gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai' },
  ];
  assert.equal(preferredModel('openai', modelOptions, [], { provider: 'openai', model: 'gpt-5.4' }), 'openai/gpt-6-astra');
});
