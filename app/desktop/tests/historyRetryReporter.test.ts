import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestCase, TestResult } from '@playwright/test/reporter';

import HistoryRetryReporter, { excusedRetryReason } from './visual/historyRetryReporter';

type Attempt = Pick<TestResult, 'status' | 'errors' | 'retry'>;

// Playwright reports the bare timeout line wrapped in terminal color codes.
const TIMEOUT = '\u001b[31mTest timeout of 90000ms exceeded.\u001b[39m';
const HUNG_WHEEL = 'Error: mouse.wheel: Protocol error (Input.dispatchWheelEvent): Page closed';
const BROWSER_LOST = 'the browser process was lost';
const WHEEL_UNACKNOWLEDGED = 'a wheel event was never acknowledged';

const attempt = (retry: number, status: TestResult['status'], ...messages: string[]): Attempt =>
  ({ retry, status, errors: messages.map(message => ({ message })) });

function finish(reporter: HistoryRetryReporter, title: string, attempts: Attempt[]): void {
  const testCase = { results: attempts, titlePath: () => ['', 'webkit', 'history.spec.ts', title] };
  for (const result of attempts) reporter.onTestEnd(testCase as unknown as TestCase, result as TestResult);
}

async function end(reporter: HistoryRetryReporter): Promise<{ status: string | undefined; output: string }> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { written.push(chunk); return true; }) as typeof process.stdout.write;
  try {
    return { status: (await reporter.onEnd())?.status, output: written.join('') };
  } finally {
    process.stdout.write = original;
  }
}

test('a lost browser process may be retried', () => {
  assert.equal(excusedRetryReason(attempt(0, 'failed', 'Error: page.waitForTimeout: Page crashed')), BROWSER_LOST);
  assert.equal(excusedRetryReason(attempt(0, 'failed', 'Error: locator.evaluate: Target crashed')), BROWSER_LOST);
  assert.equal(excusedRetryReason(attempt(0, 'failed', 'Error: mouse.wheel: Target page, context or browser has been closed')), BROWSER_LOST);
});

test('a timeout may be retried only while waiting inside mouse.wheel', () => {
  assert.equal(excusedRetryReason(attempt(0, 'timedOut', TIMEOUT, HUNG_WHEEL)), WHEEL_UNACKNOWLEDGED);
  assert.equal(excusedRetryReason(attempt(0, 'timedOut', 'Error: mouse.wheel: Test timeout of 90000ms exceeded.')), WHEEL_UNACKNOWLEDGED);
  assert.equal(excusedRetryReason(attempt(0, 'timedOut', TIMEOUT)), undefined);
  assert.equal(excusedRetryReason(attempt(0, 'timedOut', TIMEOUT, 'Error: page.waitForTimeout: Test timeout of 90000ms exceeded.')), undefined);
  assert.equal(excusedRetryReason(attempt(0, 'timedOut', TIMEOUT, 'Error: page.evaluate: Target page, context or browser has been closed')), undefined);
  assert.equal(excusedRetryReason(attempt(0, 'timedOut', TIMEOUT, HUNG_WHEEL, 'Error: expect(received).toBe(expected)')), undefined);
});

test('any other failure may not be retried', () => {
  assert.equal(excusedRetryReason(attempt(0, 'failed', 'Error: expect(received).toBeLessThanOrEqual(expected)')), undefined);
  assert.equal(excusedRetryReason(attempt(0, 'failed', 'Error: Page crashed', 'Error: expect(received).toBe(expected)')), undefined);
  assert.equal(excusedRetryReason(attempt(0, 'failed', HUNG_WHEEL)), undefined);
  assert.equal(excusedRetryReason(attempt(0, 'failed')), undefined);
});

test('a pass after an excused failure is reported and keeps the run status', async () => {
  const reporter = new HistoryRetryReporter();
  finish(reporter, 'first attempt passes', [attempt(0, 'passed')]);
  finish(reporter, 'follows the gesture', [attempt(0, 'failed', 'Error: page.waitForTimeout: Page crashed'), attempt(1, 'passed')]);
  finish(reporter, 'slow scrolling', [attempt(0, 'timedOut', TIMEOUT, HUNG_WHEEL), attempt(1, 'passed')]);
  const { status, output } = await end(reporter);
  assert.equal(status, undefined);
  assert.match(output, /Passed on retry after the browser process was lost: webkit › history\.spec\.ts › follows the gesture/);
  assert.match(output, /Passed on retry after a wheel event was never acknowledged: webkit › history\.spec\.ts › slow scrolling/);
  assert.doesNotMatch(output, /first attempt passes/);
});

test('a pass after any other failure fails the run', async () => {
  const reporter = new HistoryRetryReporter();
  finish(reporter, 'follows the gesture', [attempt(0, 'failed', 'Error: expect(received).toBeLessThanOrEqual(expected)'), attempt(1, 'passed')]);
  finish(reporter, 'slow scrolling', [attempt(0, 'timedOut', TIMEOUT), attempt(1, 'passed')]);
  const { status, output } = await end(reporter);
  assert.equal(status, 'failed');
  assert.match(output, /so the run fails: webkit › history\.spec\.ts › follows the gesture/);
  assert.match(output, /so the run fails: webkit › history\.spec\.ts › slow scrolling/);
});

test('a test that fails twice is left to the runner', async () => {
  const reporter = new HistoryRetryReporter();
  finish(reporter, 'follows the gesture', [attempt(0, 'failed', 'Error: Page crashed'), attempt(1, 'failed', 'Error: Page crashed')]);
  assert.deepEqual(await end(reporter), { status: undefined, output: '' });
});
