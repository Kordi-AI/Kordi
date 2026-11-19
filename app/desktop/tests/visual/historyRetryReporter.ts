import process from 'node:process';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

// On CI the history suite retries a failed test once, because a hosted runner
// occasionally loses the WebKit process in the middle of a wheel gesture, or
// never acknowledges a wheel event. A retry must not hide a scroll-stability
// regression, so this reporter names every retry it excuses and fails the run
// when a test passed only after an attempt that failed for any other reason.

// Playwright wraps some messages in terminal color codes, so nothing here
// anchors on the start of the text.
const BROWSER_LOST = /(?:Page|Target) crashed\b|Target page, context or browser has been closed\b/;
const TEST_TIMEOUT = /Test timeout of \d+ms exceeded\b/;
const WHEEL_DISPATCH = /mouse\.wheel: /;

// Returns why a failed attempt may be retried, or undefined when it may not.
// A timeout is excused only while the test was waiting inside mouse.wheel.
export function excusedRetryReason(attempt: Pick<TestResult, 'status' | 'errors'>): string | undefined {
  const messages = attempt.errors.map(error => error.message ?? '');
  if (messages.length === 0) return undefined;
  if (attempt.status === 'failed' && messages.every(message => BROWSER_LOST.test(message))) return 'the browser process was lost';
  if (attempt.status === 'timedOut' && messages.some(message => WHEEL_DISPATCH.test(message))
    && messages.every(message => WHEEL_DISPATCH.test(message) || TEST_TIMEOUT.test(message))) return 'a wheel event was never acknowledged';
  return undefined;
}

function report(level: 'warning' | 'error', message: string): void {
  // GitHub Actions turns these workflow commands into run annotations.
  process.stdout.write(process.env.GITHUB_ACTIONS ? `::${level} title=Transcript history retry::${message}\n` : `${level}: ${message}\n`);
}

export default class HistoryRetryReporter implements Reporter {
  private readonly excusedRetries: string[] = [];
  private readonly maskedFailures: string[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status !== 'passed' || result.retry === 0) return;
    const reasons = test.results.filter(attempt => attempt.retry < result.retry).map(excusedRetryReason);
    const title = test.titlePath().filter(Boolean).join(' › ');
    if (reasons.every(reason => reason !== undefined)) this.excusedRetries.push(`Passed on retry after ${[...new Set(reasons)].join(' and ')}: ${title}`);
    else this.maskedFailures.push(`Passed on retry after a failure that may not be retried, so the run fails: ${title}`);
  }

  // The Reporter type accepts a status override only as a promise.
  async onEnd(): Promise<{ status: FullResult['status'] } | undefined> {
    for (const message of this.excusedRetries) report('warning', message);
    for (const message of this.maskedFailures) report('error', message);
    return this.maskedFailures.length > 0 ? { status: 'failed' } : undefined;
  }
}
