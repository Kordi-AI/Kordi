import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  portableCloudAgentAuthChoice,
  resolveDefaultCloudAgentRuntimeRoute,
} from '../src/app/useKordiDefaultCloudAgentRuntimeRoute';
import type { DesktopAuthProvider, DesktopAuthState } from '../src/kordi-app/types';

function openAiProvider(): DesktopAuthProvider {
  return {
    id: 'openai',
    label: 'OpenAI',
    statusSummary: 'configured',
    loginHint: 'Use an API key.',
    envVar: 'OPENAI_API_KEY',
    helpUrl: 'https://platform.openai.com/api-keys',
    supportsOAuth: false,
    supportsApiKey: true,
    configured: true,
    authority: null,
    baseUrl: null,
    preferredModel: null,
    options: [{
      value: 'profile-1',
      profileId: 'profile-1',
      method: 'API key',
      source: 'kordi auth.json',
      label: 'Saved key',
      active: true,
    }],
  };
}

function authState(providers: DesktopAuthProvider[]): DesktopAuthState {
  return {
    authPath: '/tmp/kordi-auth.json',
    hasAnyAuth: providers.length > 0,
    providers,
  };
}

const activeOpenAiAuthOption = {
  providerId: 'openai',
  providerLabel: 'OpenAI',
  methodLabel: 'OpenAI API key',
  value: 'profile-1',
  label: 'Saved key',
  active: true,
};

test('portable cloud routes keep explicit profile selectors', () => {
  assert.equal(portableCloudAgentAuthChoice('profile:chatgpt', 'OAuth'), 'profile:chatgpt');
  assert.equal(portableCloudAgentAuthChoice('profile:api-key', 'OpenAI API key'), 'profile:api-key');
});

test('default cloud agent route stays disabled outside the native shell', () => {
  assert.equal(resolveDefaultCloudAgentRuntimeRoute({
    activeLoginProviderId: 'openai',
    authOptions: [activeOpenAiAuthOption],
    chatModelOptions: [{ value: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
    desktopAuthState: authState([openAiProvider()]),
    isNativeShell: false,
    preferredModelValueForProvider: () => 'openai/gpt-5.6-sol',
    resolveComposerProviderId: () => 'openai',
    selectedModel: 'openai/gpt-5.6-sol',
    selectedThinking: 'medium',
  }), null);
});

test('default cloud agent route preserves a configured selected model and auth choice', () => {
  assert.deepEqual(resolveDefaultCloudAgentRuntimeRoute({
    activeLoginProviderId: 'openai',
    authOptions: [activeOpenAiAuthOption],
    chatModelOptions: [{ value: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
    desktopAuthState: authState([openAiProvider()]),
    isNativeShell: true,
    preferredModelValueForProvider: () => null,
    resolveComposerProviderId: () => 'openai',
    selectedModel: 'openai/gpt-5.6-sol',
    selectedThinking: 'medium',
  }), {
    model: 'openai/gpt-5.6-sol',
    authProvider: 'openai',
    authChoice: 'local-active-api-key',
    thinking: 'medium',
  });
});

test('default cloud agent route falls back to the active configured provider', () => {
  assert.deepEqual(resolveDefaultCloudAgentRuntimeRoute({
    activeLoginProviderId: 'openai',
    authOptions: [activeOpenAiAuthOption],
    chatModelOptions: [],
    desktopAuthState: authState([openAiProvider()]),
    isNativeShell: true,
    preferredModelValueForProvider: (providerId) => (
      providerId === 'openai' ? 'openai/gpt-5.6-sol' : null
    ),
    resolveComposerProviderId: () => '',
    selectedModel: '',
    selectedThinking: '',
  }), {
    model: 'openai/gpt-5.6-sol',
    authProvider: 'openai',
    authChoice: 'local-active-api-key',
    thinking: '',
  });
});

test('a new session without a provider on this Mac starts on a usable Kordi Cloud account', async () => {
  const { publishHostedProviderSnapshots } = await import('../src/features/cloud/hostedAccounts');
  const args = {
    activeLoginProviderId: null,
    authOptions: [],
    chatModelOptions: [],
    desktopAuthState: authState([]),
    isNativeShell: true,
    preferredModelValueForProvider: () => null,
    resolveComposerProviderId: () => 'anthropic',
    selectedModel: 'anthropic/claude-fable-5',
    selectedThinking: 'medium',
  };
  // The Kordi Cloud list has not arrived: an account may still exist, so no route yet.
  assert.equal(resolveDefaultCloudAgentRuntimeRoute(args), null);
  publishHostedProviderSnapshots([{ snapshotId: 'synthetic-work', provider: 'openai-codex', authChoice: 'cloud-login:work',
    label: 'Work', modelHint: 'gpt-6-sol', createdAt: '2026-01-01T00:00:00Z', revokedAt: null }]);
  try {
    assert.deepEqual(resolveDefaultCloudAgentRuntimeRoute(args),
      { model: 'openai-codex/gpt-6-sol', authProvider: 'openai-codex', authChoice: 'cloud-login:work', thinking: 'medium' });
    assert.equal(resolveDefaultCloudAgentRuntimeRoute({ ...args, desktopAuthState: null }), null, 'Not while this Mac\'s accounts load');
  } finally {
    publishHostedProviderSnapshots([]);
  }
  assert.equal(resolveDefaultCloudAgentRuntimeRoute(args), null, 'No usable account anywhere keeps the no-provider state');
});

test('default cloud agent route moves the model into the chosen account namespace', () => {
  assert.deepEqual(resolveDefaultCloudAgentRuntimeRoute({
    activeLoginProviderId: 'openai',
    authOptions: [{
      providerId: 'openai-codex', providerLabel: 'OpenAI', methodLabel: 'Saved account',
      value: 'cloud-login:x', label: 'Work', active: false,
    }],
    chatModelOptions: [
      { value: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { value: 'openai-codex/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    ],
    desktopAuthState: authState([openAiProvider()]),
    isNativeShell: true,
    preferredModelValueForProvider: () => null,
    resolveComposerProviderId: () => 'openai',
    selectedModel: 'openai/gpt-6.1-sol',
    selectedThinking: 'medium',
  }), {
    model: 'openai-codex/gpt-6.1-sol',
    authProvider: 'openai-codex',
    authChoice: 'cloud-login:x',
    thinking: 'medium',
  });
});

test('with an OpenAI key and a ChatGPT sign-in both active, a ChatGPT model keeps the sign-in', () => {
  const args = {
    activeLoginProviderId: 'openai',
    authOptions: [
      { providerId: 'openai', providerLabel: 'OpenAI', methodLabel: 'API key', value: 'profile:key', label: 'Key', active: true },
      { providerId: 'openai-codex', providerLabel: 'OpenAI', methodLabel: 'OAuth', value: 'profile:chatgpt', label: 'ChatGPT', active: true },
    ],
    chatModelOptions: [
      { value: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { value: 'openai-codex/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    ],
    desktopAuthState: authState([openAiProvider()]),
    isNativeShell: true,
    preferredModelValueForProvider: () => null,
    resolveComposerProviderId: () => 'openai',
    selectedThinking: 'medium',
  };
  const chatgpt = resolveDefaultCloudAgentRuntimeRoute({ ...args, selectedModel: 'openai-codex/gpt-6.1-sol' });
  assert.equal(chatgpt?.model, 'openai-codex/gpt-6.1-sol');
  assert.equal(chatgpt?.authProvider, 'openai-codex');
  assert.equal(chatgpt?.authChoice, 'profile:chatgpt');
  const key = resolveDefaultCloudAgentRuntimeRoute({ ...args, selectedModel: 'openai/gpt-6.1-sol' });
  assert.equal(key?.model, 'openai/gpt-6.1-sol');
  assert.equal(key?.authChoice, 'profile:key');
});


test('browser default route keeps a hosted account and never uses native saved credentials', () => {
  const args = {
    activeLoginProviderId: 'openai',
    authOptions: [{ ...activeOpenAiAuthOption, value: 'cloud-login:browser', providerId: 'openai-codex' }],
    chatModelOptions: [{ value: 'openai-codex/gpt-6-sol', label: 'Model' }],
    desktopAuthState: authState([openAiProvider()]),
    isNativeShell: false, browserApp: true,
    preferredModelValueForProvider: () => 'openai-codex/gpt-6-sol',
    resolveComposerProviderId: () => 'openai-codex',
    selectedModel: 'openai-codex/gpt-6-sol', selectedThinking: 'medium',
  };
  assert.deepEqual(resolveDefaultCloudAgentRuntimeRoute(args), {
    model: 'openai-codex/gpt-6-sol', authProvider: 'openai-codex',
    authChoice: 'cloud-login:browser', thinking: 'medium',
  });
  const nativeOnly = resolveDefaultCloudAgentRuntimeRoute({ ...args,
    authOptions: [activeOpenAiAuthOption], selectedModel: 'openai/gpt-6-sol',
    resolveComposerProviderId: () => 'openai',
  });
  assert.notEqual(nativeOnly?.authChoice, 'local-active-api-key');
  assert.notEqual(nativeOnly?.authChoice, 'profile-1');
});

test('a browser chat with no stored route shows and sends the hosted account default model at its default effort', async () => {
  const { initialComposerSelections } = await import('../src/app/useKordiLocalUiState');
  const { chatComposerSelectionForRoute } = await import('../src/app/useCloudAgentRuntimeRouteSync');
  const { hostedAuthOptions, hostedModelOptions, hostedRouteAccounts } = await import('../src/features/chat/hostedComposerOptions');
  const { routeForSendWithoutLocalProvider } = await import('../src/features/chat/messageActions/noProviderRoute');
  const { preferredModelValueForProviderFromOptions } = await import('../src/features/chat/useComposerViewModel');
  const { loadPinnedOmpCatalog } = await import('../src/kordi-app/auth/ompCatalog');
  const { composerModelChipLabels, modelDisplayName } = await import('../src/lib/modelDisplayName');

  // Nothing has chosen a model yet: no GPT-5.4 and no forced effort.
  assert.deepEqual(initialComposerSelections.chat, { mode: 'Send as Me', model: '', thinking: 'default' });
  assert.equal(initialComposerSelections.project.model, '');
  assert.equal(composerModelChipLabels({ model: initialComposerSelections.chat.model, thinking: initialComposerSelections.chat.thinking, hasProvider: true }).model, 'Default');

  const { providers: catalog } = await loadPinnedOmpCatalog();
  const accounts = hostedRouteAccounts([{ authChoice: 'cloud-login:work', label: 'Work', provider: 'openai-codex', model: null, needsReconnect: false }], catalog, new Set());
  const chatModelOptions = hostedModelOptions(accounts, catalog).map((option) => ({ ...option, label: modelDisplayName(option.value, option.label) }));
  const args = {
    activeLoginProviderId: null,
    authOptions: hostedAuthOptions(accounts, null),
    chatModelOptions,
    desktopAuthState: null,
    isNativeShell: false,
    browserApp: true,
    preferredModelValueForProvider: (providerId: string) => preferredModelValueForProviderFromOptions(providerId, chatModelOptions, []),
    resolveComposerProviderId: () => 'openai',
  };
  const route = resolveDefaultCloudAgentRuntimeRoute({ ...args, selectedModel: initialComposerSelections.chat.model, selectedThinking: initialComposerSelections.chat.thinking });
  assert.deepEqual(route, { model: 'openai-codex/gpt-6.2-sol', authProvider: 'openai-codex', authChoice: 'cloud-login:work', thinking: 'default' });

  // The composer shows that route, and showing it settles: the next default is the same route.
  const shown = chatComposerSelectionForRoute(initialComposerSelections, null, route);
  assert.deepEqual(shown.chat, { mode: 'Send as Me', model: 'openai-codex/gpt-6.2-sol', thinking: 'default' });
  assert.deepEqual(composerModelChipLabels({ model: shown.chat.model, modelLabel: 'GPT-6.2 Sol', thinking: shown.chat.thinking, hasProvider: true }), { model: '6.2 Sol', effort: 'Default' });
  const settled = resolveDefaultCloudAgentRuntimeRoute({ ...args, selectedModel: shown.chat.model, selectedThinking: shown.chat.thinking });
  assert.deepEqual(settled, route);
  assert.equal(chatComposerSelectionForRoute(shown, null, settled), shown);

  // A first send from that chat runs the same model at its default effort.
  assert.deepEqual(await routeForSendWithoutLocalProvider(route, shown.chat), route);

  // On the Mac, a composer with no model still waits for this Mac's session.
  assert.equal(resolveDefaultCloudAgentRuntimeRoute({ ...args, isNativeShell: true, browserApp: false,
    selectedModel: initialComposerSelections.chat.model, selectedThinking: initialComposerSelections.chat.thinking }), null);
});
