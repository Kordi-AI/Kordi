import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { recordModelAvailable, recordModelUnavailable, resetModelAvailabilityForTests } from '../src/features/chat/modelAvailability';
import { resetModelAvailabilityRoutesForTests } from '../src/features/chat/modelAvailabilityRoutes';
import {
  createModelRecoveryStore, isLatestModelRefusal, ModelRecoveryContext, resetModelRecoveryForTests,
  retryableModelRefusalRequest, type ModelRecoveryControls,
} from '../src/features/chat/modelRecovery';
import { ModelEffortPicker } from '../src/kordi-app/components/modelEffortPicker';
import { LiveChatTurnCard } from '../src/kordi-app/components/transcriptLiveTurns';
import type { ComposerRoute } from '../src/kordi-app/components/composerModelSelection';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';

const PERSONAL = 'profile:openai-codex-personal';
const WORK = 'cloud-login:work-account';
const REFUSAL = "The selected model is unavailable for this account. Choose another model. Provider response: "
  + "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account. (code=model_not_found)";
const providerOptions = [
  { value: `openai-codex::${PERSONAL}`, providerId: 'openai-codex', label: 'Personal', active: true },
  { value: `openai-codex::${WORK}`, providerId: 'openai-codex', label: 'Work', hosted: true },
];
const modelOptions = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol'].map((id) => ({
  value: `openai-codex/${id}`, label: id, provider: 'openai', thinkingLevels: ['low', 'medium', 'high'],
}));
const selection = { model: 'openai-codex/gpt-6.1-sol', thinking: 'high', authProvider: 'openai-codex', authChoice: PERSONAL };
const refused = { provider: 'openai-codex', authChoice: PERSONAL, model: 'openai-codex/gpt-6.1-sol' };

const failedTurn: DesktopChatTurnSnapshot = {
  id: 'turn-refused', sessionId: 'session-1', prompt: 'Summarize the plan', status: 'failed', message: REFUSAL,
  assistantText: '', thinkingText: '', tools: [], completed: true, succeeded: false, error: REFUSAL,
  replyToMessageId: 'msg-request',
};
const request: Message = { id: 'msg-request', role: 'user', isOwnMessage: true, text: '@Pebble summarize the plan', time: '9:00' };
const reply: Message = { id: 'msg-reply', role: 'owned-agent', text: '', time: '9:01', turn: failedTurn };

function reset() {
  resetModelAvailabilityForTests();
  resetModelAvailabilityRoutesForTests();
  resetModelRecoveryForTests();
}

function picker(authChoice: string) {
  return renderToStaticMarkup(createElement(ModelEffortPicker, {
    selection: { ...selection, authChoice }, providerOptions, modelOptions, defaultOpen: true, onApply: () => undefined,
  }));
}

test('the picker lists a refused model as unavailable for that sign-in only', () => {
  reset();
  recordModelUnavailable(refused);
  const personal = picker(PERSONAL);
  assert.match(personal, /<button[^>]*disabled=""[^>]*><span>GPT-6\.1 Sol<small[^>]*>Not available with this account<\/small>/);
  assert.match(personal, /<button[^>]*><span>GPT-6 Astra<small[^>]*>OpenAI<\/small>/);
  // Default follows the catalog order past the refused model.
  assert.match(personal, /Default<small[^>]*>GPT-6 Astra<\/small>/);

  const work = picker(WORK);
  assert.doesNotMatch(work, /Not available with this account/);
  assert.match(work, /Default<small[^>]*>GPT-6\.1 Sol<\/small>/);
});

function renderFailure(controls: ModelRecoveryControls | null, messages: Message[] = [request, reply], owner = true) {
  const store = createModelRecoveryStore();
  store.set(controls);
  store.setMessages(messages);
  return renderToStaticMarkup(createElement(ModelRecoveryContext.Provider, { value: store },
    createElement(LiveChatTurnCard, { turn: failedTurn, historical: true, onOpenAuthSettings: owner ? () => undefined : undefined })));
}

const controls: ModelRecoveryControls = {
  selection, providerOptions, modelOptions, applyRoute: () => true, send: () => undefined,
};

test('the owner sees one-click recovery on the refused reply', () => {
  reset();
  recordModelUnavailable(refused);
  assert.match(renderFailure(controls), /class="app-error-line-action"[^>]*>Use GPT-6 Astra</);

  recordModelAvailable({ ...refused, authChoice: WORK });
  assert.match(renderFailure(controls), /class="app-error-line-action"[^>]*>Use Work</);

  // Other members, and chats without a route to change, get no action.
  assert.doesNotMatch(renderFailure(controls, [request, reply], false), /app-error-line-action/);
  assert.doesNotMatch(renderFailure(null), /app-error-line-action/);
});

test('recovery runs the owner\'s own request again, only from the latest refusal', () => {
  assert.equal(retryableModelRefusalRequest(failedTurn, [request, reply])?.text, '@Pebble summarize the plan');
  assert.equal(retryableModelRefusalRequest(failedTurn, [{ ...request, isOwnMessage: false, role: 'person' }, reply]), null);
  assert.equal(retryableModelRefusalRequest(failedTurn, [{ ...request, attachments: [{ name: 'a.png', kind: 'image' } as never] }, reply]), null);

  const later = { ...reply, id: 'msg-reply-2', turn: { ...failedTurn, id: 'turn-refused-2' } };
  assert.equal(isLatestModelRefusal(failedTurn, [request, reply]), true);
  assert.equal(isLatestModelRefusal(failedTurn, [request, reply, later]), false);
  // A live turn not yet in the transcript is the latest.
  assert.equal(isLatestModelRefusal({ ...failedTurn, id: 'live' }, [request, reply]), true);
});

test('one click saves the new route and sends the request again once', async () => {
  reset();
  recordModelUnavailable(refused);
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const replacements = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.entries(replacements).forEach(([key, value]) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }));
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  const applied: ComposerRoute[] = [];
  const sent: string[] = [];
  const store = createModelRecoveryStore();
  store.set({ ...controls, applyRoute: (route) => { applied.push(route); return true; }, send: (text) => { sent.push(text); } });
  store.setMessages([request, reply]);
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(createElement(ModelRecoveryContext.Provider, { value: store },
      createElement(LiveChatTurnCard, { turn: failedTurn, historical: true, onOpenAuthSettings: () => undefined }))));
    const button = document.querySelector<HTMLButtonElement>('.app-error-line-action');
    assert.equal(button?.textContent, 'Use GPT-6 Astra');
    await act(async () => { button!.click(); });
    await act(async () => { button?.click(); });
    assert.equal(applied.length, 1);
    assert.equal(applied[0].model, 'openai-codex/gpt-6-astra');
    assert.equal(applied[0].providerOption?.value, `openai-codex::${PERSONAL}`);
    assert.deepEqual(sent, ['@Pebble summarize the plan']);
    assert.equal(document.querySelector('.app-error-line-action'), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    originals.forEach((descriptor, key) => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    });
  }
});
