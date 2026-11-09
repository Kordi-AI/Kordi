import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AGENT_EXCHANGE_WAITING } from '../src/features/cloud/agentExchangeOutcome';
import { publicAgentExchangeTurn, agentExchangeProgressTurn } from '../src/features/cloud/agentExchangePresentation';
import { parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { mergeDesktopTurnSnapshot } from '../src/features/chat/desktopLiveTurns';
import { liveTurnSnapshotKey } from '../src/features/chat/liveTurnSnapshotKey';
import { TurnProgress } from '../src/kordi-app/components/TurnProgress';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';

const base: DesktopChatTurnSnapshot = { id: 'turn', sessionId: 'session', prompt: '', message: '', assistantText: '', thinkingText: '', tools: [], completed: false, succeeded: false, status: 'processing', error: null };

test('ordered metadata arriving before assistantText cannot flash, including retained history segments', () => {
  for (let end = 1; end <= AGENT_EXCHANGE_WAITING.length; end++) {
    const turn = { ...base, segments: [{ id: 'ordered', kind: 'text' as const, text: AGENT_EXCHANGE_WAITING.slice(0, end) }] };
    const publicTurn = publicAgentExchangeTurn(turn);
    assert.equal(publicTurn.completed, false);
    const html = renderToStaticMarkup(createElement(TurnProgress, { turn: publicTurn, renderTool: () => null }));
    assert.match(html, /Working/);
    assert.doesNotMatch(html, /agentExchangeOutcome|waiting/);
    assert.deepEqual(publicTurn.segments, []);
  }
  const retained = mergeDesktopTurnSnapshot({ ...base, assistantText: AGENT_EXCHANGE_WAITING, segments: [{ id: 'ordered', kind: 'text', text: AGENT_EXCHANGE_WAITING }] }, { ...base, completed: true, succeeded: true, status: 'complete' });
  const publicTurn = publicAgentExchangeTurn(retained);
  assert.equal(publicTurn.assistantText, '');
  assert.deepEqual(publicTurn.segments, []);
});

test('the question retains waiting and processing feedback until durable completion without extra speech', () => {
  const text = '@Peer What is 12 + 7?';
  const waiting = agentExchangeProgressTurn('waiting', text, 'question', 'session')!;
  const processing = agentExchangeProgressTurn('processing', text, 'question', 'session')!;
  assert.notEqual(liveTurnSnapshotKey(waiting), liveTurnSnapshotKey(processing));
  for (const [turn, label] of [[waiting, 'Waiting for reply'], [processing, 'Processing reply']] as const) {
    const html = renderToStaticMarkup(createElement(TurnProgress, { turn, renderTool: () => null, legacyAnswer: text }));
    assert.match(html, new RegExp(label));
    assert.match(html, /What is 12/);
    assert.doesNotMatch(html, /agentExchangeStatus|agentExchangeOutcome/);
  }
  for (const status of ['completed', 'failed', 'cancelled']) assert.equal(agentExchangeProgressTurn(status, text, 'question', 'session'), null);
});

test('a question to a person names who the agent is waiting for', () => {
  const text = '@Maya Which day works?';
  const body = `kordi-cloud-agent-response:${Buffer.from(JSON.stringify({ kind: 'agent-response', requestId: 'agent-exchange:id:sent', text, deliveryState: 'complete', agentExchangeStatus: 'waiting', agentExchangeWaitingFor: 'Maya Chen' })).toString('base64url')}`;
  const parsed = parseCloudAgentResponse(body)!;
  assert.equal(parsed.agentExchangeWaitingFor, 'Maya Chen');
  const waiting = agentExchangeProgressTurn(parsed.agentExchangeStatus, text, 'question', 'session', null, parsed.agentExchangeWaitingFor)!;
  assert.equal(waiting.agentExchangeWaitingFor, 'Maya Chen');
  const html = renderToStaticMarkup(createElement(TurnProgress, { turn: waiting, renderTool: () => null, legacyAnswer: text }));
  assert.match(html, /Waiting for Maya Chen/);
  const processing = agentExchangeProgressTurn('processing', text, 'question', 'session', null, 'Maya Chen')!;
  assert.match(renderToStaticMarkup(createElement(TurnProgress, { turn: processing, renderTool: () => null, legacyAnswer: text })), /Processing reply/);
  assert.equal(agentExchangeProgressTurn('waiting', text, 'question', 'session', null, '  ')!.agentExchangeWaitingFor, undefined);
});

test('ordinary text, ordered prose, and genuine errors survive presentation filtering', () => {
  const turn = { ...base, assistantText: '{"answer":19}', message: 'Provider failed', error: 'Provider failed', status: 'failed', completed: true, segments: [{ id: 'ordered', kind: 'text' as const, text: 'Useful result' }] };
  assert.deepEqual(publicAgentExchangeTurn(turn), turn);
});
