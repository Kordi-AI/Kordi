import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backgroundSessionRowExecution } from '../src/features/chat/relatedAgentSessions';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';

const turn = (overrides: Partial<DesktopChatTurnSnapshot>): DesktopChatTurnSnapshot => ({
  id: 'turn', sessionId: 'child', prompt: '', status: 'streaming', message: '', assistantText: '', thinkingText: '',
  tools: [], completed: false, succeeded: false, startedAtMs: 1_000, completedAtMs: null, ...overrides,
});

// The group row of a background session follows its newest execution. A
// stopped session that is continued shows Running, then Done, even when the
// continue runs as a turn this row does not track.
test('a stopped background session row follows a continue through running to done', () => {
  const stopped = turn({ id: 'first', status: 'cancelled', completed: true, startedAtMs: 1_000, completedAtMs: 460_000 });
  const stoppedRecord = { status: 'stopped', startedAtMs: 1_050 };
  assert.deepEqual(backgroundSessionRowExecution(stopped, stoppedRecord), { status: 'stopped', localTurn: stopped });

  // The continue started: the cloud record runs a newer execution while the
  // row still tracks the stopped turn.
  const continuing = { status: 'running', startedAtMs: 1_375_000 };
  assert.deepEqual(backgroundSessionRowExecution(stopped, continuing), { status: 'running', localTurn: null });

  // The row then finds the continue's own turn on this Mac, which started a
  // moment before the cloud marked the execution running.
  const followUp = turn({ id: 'continue', startedAtMs: 1_374_800 });
  assert.deepEqual(backgroundSessionRowExecution(followUp, continuing), { status: 'running', localTurn: followUp });

  const finished = { ...followUp, status: 'succeeded', completed: true, succeeded: true, completedAtMs: 1_435_000 };
  assert.deepEqual(backgroundSessionRowExecution(finished, { status: 'done', startedAtMs: 1_375_000 }), { status: 'done', localTurn: finished });
  // Before the row sees the finished local turn, the record alone says done.
  assert.equal(backgroundSessionRowExecution(stopped, { status: 'done', startedAtMs: 1_375_000 })?.status, 'done');
});

test('a just-stopped turn is not overridden by a record that has not caught up', () => {
  const stopped = turn({ status: 'cancelled', completed: true, startedAtMs: 1_000, completedAtMs: 460_000 });
  // The record still says running for the same execution until the stop is
  // published; it dates the execution by its first message.
  assert.equal(backgroundSessionRowExecution(stopped, { status: 'running', startedAtMs: 1_050 })?.status, 'stopped');
  assert.equal(backgroundSessionRowExecution(stopped, { status: 'running', startedAtMs: 900 })?.status, 'stopped');
  assert.equal(backgroundSessionRowExecution(stopped, { status: 'running', startedAtMs: null })?.status, 'stopped');
  assert.equal(backgroundSessionRowExecution(null, null), null);
});
