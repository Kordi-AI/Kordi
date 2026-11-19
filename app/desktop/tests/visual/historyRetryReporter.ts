import process from 'node:process';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

// On CI the history suite retries a failed test once, because a hosted runner
// occasionally loses the WebKit process in the middle of a wheel gesture. A
// retry must not hide a scroll-stability regression, so this reporter names
// every retried browser loss and fails the run when a test passed only after
// an attempt that failed for any other reason.
const BROWSER_LOST = /\b(?:Page|Target) crashed\b|\bTarget page, context or browser has been closed\b/;

// A timeout closes the page too, but it ends as 'timedOut' and is never excused.
export function isBrowserLoss(attempt: Pick<TestResult, 'status' | 'errors'>): boolean {
  return attempt.status === 'failed' && attempt.errors.length > 0
    && attempt.errors.every(error => BROWSER_LOST.test(error.message ?? ''));
}

function report(level: 'warning' | 'error', message: string): void {
  // GitHub Actions turns these workflow commands into run annotations.
  process.stdout.write(process.env.GITHUB_ACTIONS ? `::${level} title=Transcript history retry::${message}\n` : `${level}: ${message}\n`);
}

export default class HistoryRetryReporter implements Reporter {
  private readonly retriedBrowserLosses: string[] = [];
  private readonly maskedFailures: string[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status !== 'passed' || result.retry === 0) return;
    const earlier = test.results.filter(attempt => attempt.retry < result.retry);
    const title = test.titlePath().filter(Boolean).join(' › ');
    (earlier.every(isBrowserLoss) ? this.retriedBrowserLosses : this.maskedFailures).push(title);
  }

  // The Reporter type accepts a status override only as a promise.
  async onEnd(): Promise<{ status: FullResult['status'] } | undefined> {
    for (const title of this.retriedBrowserLosses) report('warning', `Passed on retry after the browser process was lost: ${title}`);
    for (const title of this.maskedFailures) report('error', `Passed on retry after a failure that was not a lost browser process, so the run fails: ${title}`);
    return this.maskedFailures.length > 0 ? { status: 'failed' } : undefined;
  }
}
