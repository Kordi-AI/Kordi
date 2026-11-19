import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestCase, TestResult } from '@playwright/test/reporter';

import HistoryRetryReporter, { isBrowserLoss } from './visual/historyRetryReporter';

type Attempt = Pick<TestResult, 'status' | 'errors' | 'retry'>;

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

test('only a lost browser process counts as a browser loss', () => {
  assert.equal(isBrowserLoss(attempt(0, 'failed', 'Error: page.waitForTimeout: Page crashed')), true);
  assert.equal(isBrowserLoss(attempt(0, 'failed', 'Error: locator.evaluate: Target crashed')), true);
  assert.equal(isBrowserLoss(attempt(0, 'failed', 'Error: mouse.wheel: Target page, context or browser has been closed')), true);
  assert.equal(isBrowserLoss(attempt(0, 'failed', 'Error: expect(received).toBeLessThanOrEqual(expected)')), false);
  assert.equal(isBrowserLoss(attempt(0, 'failed', 'Error: Page crashed', 'Error: expect(received).toBe(expected)')), false);
  assert.equal(isBrowserLoss(attempt(0, 'timedOut', 'Test timeout of 90000ms exceeded.', 'Error: mouse.wheel: Target page, context or browser has been closed')), false);
  assert.equal(isBrowserLoss(attempt(0, 'failed')), false);
});

test('a pass after a browser loss is reported and keeps the run status', async () => {
  const reporter = new HistoryRetryReporter();
  finish(reporter, 'first attempt passes', [attempt(0, 'passed')]);
  finish(reporter, 'follows the gesture', [attempt(0, 'failed', 'Error: page.waitForTimeout: Page crashed'), attempt(1, 'passed')]);
  const { status, output } = await end(reporter);
  assert.equal(status, undefined);
  assert.match(output, /Passed on retry after the browser process was lost: webkit › history\.spec\.ts › follows the gesture/);
  assert.doesNotMatch(output, /first attempt passes/);
});

test('a pass after any other failure fails the run', async () => {
  const reporter = new HistoryRetryReporter();
  finish(reporter, 'follows the gesture', [attempt(0, 'failed', 'Error: expect(received).toBeLessThanOrEqual(expected)'), attempt(1, 'passed')]);
  finish(reporter, 'slow scrolling', [attempt(0, 'timedOut', 'Test timeout of 90000ms exceeded.'), attempt(1, 'passed')]);
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
