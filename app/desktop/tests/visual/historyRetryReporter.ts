import { basename } from 'node:path';
import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';
import type { FullResult, Reporter, TestCase, TestResult, TestStep } from '@playwright/test/reporter';

// On CI the history suite retries a failed test once, because a hosted runner
// occasionally loses the WebKit process in the middle of a wheel gesture, or
// never acknowledges a wheel event. A retry must not hide a scroll-stability
// regression, so this reporter names every retry it excuses and fails the run
// when a test passed only after an attempt that failed for any other reason.

// Match the Playwright API error header. Assertion values, call logs, and
// browser logs can quote the same words later in the message.
const BROWSER_LOST = /^(?:Error: )?(?:page|locator|mouse)\.\w+: (?:Page crashed|Target crashed|Target page, context or browser has been closed)$/;
const TEST_TIMEOUT = /^Test timeout of \d+ms exceeded\.$/;
const WHEEL_TIMEOUT = /^(?:Error: )?mouse\.wheel: (?:Test timeout of \d+ms exceeded\.|Protocol error \(Input\.dispatchWheelEvent\): Page closed|Target page, context or browser has been closed)$/;

function hasFailedAssertion(steps: TestStep[]): boolean {
  return steps.some(step => (step.category === 'expect' && step.error !== undefined) || hasFailedAssertion(step.steps));
}

export function excusedRetryReason(attempt: Pick<TestResult, 'status' | 'errors' | 'steps'>): string | undefined {
  if (hasFailedAssertion(attempt.steps)) return undefined;
  const headers = attempt.errors.map(error => stripVTControlCharacters(error.message ?? '').split('\n', 1)[0]);
  if (!headers.length) return undefined;
  if (attempt.status === 'failed' && headers.every(header => BROWSER_LOST.test(header))) return 'the browser process was lost';
  if (attempt.status === 'timedOut' && headers.some(header => WHEEL_TIMEOUT.test(header))
    && headers.every(header => WHEEL_TIMEOUT.test(header) || TEST_TIMEOUT.test(header))) return 'a wheel event was never acknowledged';
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
    const eligible = test.parent.project()?.name === 'webkit' && basename(test.location.file) === 'transcriptHistoryScrollStability.spec.ts';
    if (eligible && reasons.length > 0 && reasons.every(reason => reason !== undefined)) this.excusedRetries.push(`Passed on retry after ${[...new Set(reasons)].join(' and ')}: ${title}`);
    else this.maskedFailures.push(`Passed on retry after a failure that may not be retried, so the run fails: ${title}`);
  }

  // The Reporter type accepts a status override only as a promise.
  async onEnd(): Promise<{ status: FullResult['status'] } | undefined> {
    for (const message of this.excusedRetries) report('warning', message);
    for (const message of this.maskedFailures) report('error', message);
    return this.maskedFailures.length > 0 ? { status: 'failed' } : undefined;
  }
}
