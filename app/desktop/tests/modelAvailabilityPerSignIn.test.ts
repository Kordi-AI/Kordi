import assert from 'node:assert/strict';
import test from 'node:test';

// A stand-in for the app window's storage, so the record's persistence and
// cross-window refresh run as they do in the app. Set before the modules load.
const stored = new Map<string, string>();
const storageListeners: Array<(event: { key: string | null }) => void> = [];
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    },
    addEventListener: (type: string, listener: (event: { key: string | null }) => void) => {
      if (type === 'storage') storageListeners.push(listener);
    },
  },
});

const availability = await import('../src/features/chat/modelAvailability');
const routes = await import('../src/features/chat/modelAvailabilityRoutes');
const selection = await import('../src/kordi-app/components/composerModelSelection');
const {
  MODEL_AVAILABILITY_STORAGE_KEY, MODEL_AVAILABILITY_TTL_MS, clearProviderModelAvailability, isAccountModelRefusal,
  modelAvailabilityForSignIn, recordModelAvailable, recordModelUnavailable, resetModelAvailabilityForTests,
} = availability;
const {
  bestAvailableModel, modelRecoveryPlan, observeStartedTurn, observeTurnModelAvailability, refusedTurnRoute,
  rememberModelCatalog, resetModelAvailabilityRoutesForTests, routeWithAvailableModel,
} = routes;

// The provider's reply in the 2026-11-08 failure, after the runtime's fixed wording.
const REFUSAL = "The selected model is unavailable for this account. Choose another model. Provider response: "
  + "Codex error event: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account. (code=model_not_found)";
const PERSONAL = 'profile:openai-codex-personal';
const WORK = 'cloud-login:work-account';
const route = { model: 'openai-codex/gpt-6.1-sol', authProvider: 'openai-codex', authChoice: PERSONAL, thinking: 'high' };
const personal = { provider: 'openai-codex', authChoice: PERSONAL, model: 'openai-codex/gpt-6.1-sol' };
const providerOptions = [
  { value: `openai-codex::${PERSONAL}`, providerId: 'openai-codex', label: 'Personal', active: true },
  { value: `openai-codex::${WORK}`, providerId: 'openai-codex', label: 'Work', hosted: true },
];
const modelOptions = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol'].map((id) => ({
  value: `openai-codex/${id}`, label: id, provider: 'openai', thinkingLevels: ['low', 'medium', 'high'],
}));
const chatSelection = { model: 'openai-codex/gpt-6.1-sol', thinking: 'high', authProvider: 'openai-codex', authChoice: PERSONAL };

function turn(id: string, fields: Record<string, unknown> = {}) {
  return {
    id, sessionId: 'session-1', prompt: 'Summarize the plan', status: 'running', message: '', assistantText: '',
    thinkingText: '', tools: [], completed: false, succeeded: false, ...fields,
  };
}

function reset() {
  stored.clear();
  resetModelAvailabilityForTests();
  resetModelAvailabilityRoutesForTests();
}

test('only the account refusal counts, not an unknown model id', () => {
  assert.equal(isAccountModelRefusal(REFUSAL), true);
  assert.equal(isAccountModelRefusal(new Error('400 {"code":"model_not_found"}')), true);
  assert.equal(isAccountModelRefusal('Unknown model: openai-codex/gpt-9'), false);
  assert.equal(isAccountModelRefusal('The provider is busy or rate-limited. Try again shortly.'), false);
});

test('a refused turn records the model as unavailable for that sign-in only', () => {
  reset();
  const now = 1_000_000;
  const started = observeStartedTurn(route, turn('turn-1'), now);
  assert.equal(started.id, 'turn-1');
  assert.equal(modelAvailabilityForSignIn(personal, now), 'unknown');
  observeTurnModelAvailability(turn('turn-1', { status: 'failed', completed: true, error: REFUSAL }), now);

  assert.equal(modelAvailabilityForSignIn(personal, now), 'unavailable');
  // The same model in the plain OpenAI namespace is the same model.
  assert.equal(modelAvailabilityForSignIn({ ...personal, model: 'openai/gpt-6.1-sol' }, now), 'unavailable');
  assert.equal(modelAvailabilityForSignIn({ ...personal, authChoice: WORK }, now), 'unknown');
  assert.equal(modelAvailabilityForSignIn({ ...personal, model: 'openai-codex/gpt-6-astra' }, now), 'unknown');
  assert.deepEqual(refusedTurnRoute('turn-1'), personal);

  // Persisted: another window reloads it from storage.
  const saved = JSON.parse(stored.get(MODEL_AVAILABILITY_STORAGE_KEY) ?? '{}') as { entries: unknown[] };
  assert.equal(saved.entries.length, 1);
  assert.doesNotMatch(stored.get(MODEL_AVAILABILITY_STORAGE_KEY) ?? '', /token|secret|password/i);
  storageListeners.forEach((listener) => listener({ key: MODEL_AVAILABILITY_STORAGE_KEY }));
  assert.equal(modelAvailabilityForSignIn(personal, now), 'unavailable');
});

test('other failures, routes without a sign-in, and unknown turns record nothing', () => {
  reset();
  observeStartedTurn(route, turn('busy'));
  observeTurnModelAvailability(turn('busy', { completed: true, error: 'The provider is busy or rate-limited. Try again shortly.' }));
  observeStartedTurn({ model: 'openai-codex/gpt-6.1-sol', thinking: 'high' }, turn('no-sign-in'));
  observeTurnModelAvailability(turn('no-sign-in', { completed: true, error: REFUSAL }));
  observeTurnModelAvailability(turn('never-started', { completed: true, error: REFUSAL }));
  assert.equal(modelAvailabilityForSignIn(personal), 'unknown');
  assert.equal(stored.size, 0);
});

test('a successful use clears the refusal, and a refusal expires after seven days', () => {
  reset();
  const now = 2_000_000;
  recordModelUnavailable(personal, now);
  observeStartedTurn(route, turn('turn-2'), now + 1);
  observeTurnModelAvailability(turn('turn-2', { status: 'completed', completed: true, succeeded: true }), now + 1);
  assert.equal(modelAvailabilityForSignIn(personal, now + 1), 'available');

  recordModelUnavailable({ ...personal, model: 'openai-codex/gpt-6-sol' }, now);
  assert.equal(modelAvailabilityForSignIn({ ...personal, model: 'openai-codex/gpt-6-sol' }, now + MODEL_AVAILABILITY_TTL_MS), 'unavailable');
  assert.equal(modelAvailabilityForSignIn({ ...personal, model: 'openai-codex/gpt-6-sol' }, now + MODEL_AVAILABILITY_TTL_MS + 1), 'unknown');
});

test('signing in again forgets what the provider refused', () => {
  reset();
  recordModelUnavailable(personal);
  recordModelUnavailable({ provider: 'anthropic', authChoice: 'profile:claude-team', model: 'anthropic/claude-fable-5-1' });
  clearProviderModelAvailability('openai');
  assert.equal(modelAvailabilityForSignIn(personal), 'unknown');
  assert.equal(modelAvailabilityForSignIn({ provider: 'anthropic', authChoice: 'profile:claude-team', model: 'anthropic/claude-fable-5-1' }), 'unavailable');
});

test('a run on a refused default model uses the best available model in catalog order', () => {
  reset();
  assert.equal(routeWithAvailableModel(route), route);
  recordModelUnavailable(personal);
  // Before the picker has listed models, the ChatGPT order applies.
  assert.deepEqual(routeWithAvailableModel(route), { ...route, model: 'openai-codex/gpt-6-astra' });
  rememberModelCatalog([modelOptions[0], modelOptions[2], modelOptions[1]]);
  assert.deepEqual(routeWithAvailableModel(route), { ...route, model: 'openai-codex/gpt-6-sol' });
  // Another sign-in keeps its model.
  assert.equal(routeWithAvailableModel({ ...route, authChoice: WORK }).model, 'openai-codex/gpt-6.1-sol');
  recordModelUnavailable({ ...personal, model: 'openai-codex/gpt-6-sol' });
  assert.equal(bestAvailableModel({ provider: 'openai-codex', authChoice: PERSONAL, exclude: personal.model })?.value, 'openai-codex/gpt-6-astra');
});

test('switching to a sign-in that refused the model opens on its next model', () => {
  reset();
  recordModelUnavailable({ ...personal, authChoice: WORK });
  const picked = selection.resolveComposerRoutePick({
    selection: chatSelection, providerOptions, modelOptions, pick: { type: 'provider', option: providerOptions[1] },
  });
  assert.equal(picked?.providerOption?.label, 'Work');
  assert.equal(picked?.model, 'openai-codex/gpt-6-astra');
  // An explicit model pick is left as asked.
  const explicit = selection.resolveComposerRoutePick({
    selection: { ...chatSelection, authChoice: WORK }, providerOptions, modelOptions, pick: { type: 'model', value: 'openai-codex/gpt-6.1-sol' },
  });
  assert.equal(explicit?.model, 'openai-codex/gpt-6.1-sol');
});

test('recovery switches to another sign-in known to run the model, else to the best available model', () => {
  reset();
  recordModelUnavailable(personal);
  const byModel = modelRecoveryPlan({ selection: chatSelection, providerOptions, modelOptions, refused: personal });
  assert.equal(byModel?.kind, 'model');
  assert.equal(byModel?.label, 'Use GPT-6 Astra');
  assert.equal(byModel?.route.model, 'openai-codex/gpt-6-astra');
  assert.equal(byModel?.route.providerOption?.value, `openai-codex::${PERSONAL}`);

  // A Cloud run's refusal carries no route; the chat's current one stands in.
  assert.equal(modelRecoveryPlan({ selection: chatSelection, providerOptions, modelOptions })?.route.model, 'openai-codex/gpt-6-astra');

  recordModelAvailable({ ...personal, authChoice: WORK });
  const bySignIn = modelRecoveryPlan({ selection: chatSelection, providerOptions, modelOptions, refused: personal });
  assert.equal(bySignIn?.kind, 'sign-in');
  assert.equal(bySignIn?.label, 'Use Work');
  assert.equal(bySignIn?.route.providerOption?.value, `openai-codex::${WORK}`);
  assert.equal(bySignIn?.route.model, 'openai-codex/gpt-6.1-sol');

  // The route already moved on since the refusal: nothing to offer.
  assert.equal(modelRecoveryPlan({
    selection: { ...chatSelection, model: 'openai-codex/gpt-6-astra' }, providerOptions, modelOptions, refused: personal,
  }), null);
});
