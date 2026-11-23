import { defineConfig, devices } from '@playwright/test';
import process from 'node:process';

const port = Number(process.env.KORDI_HISTORY_TEST_PORT ?? 62358);
const baseURL = `http://127.0.0.1:${port}`;
const scrollSpec = 'transcriptHistoryScrollStability.spec.ts';
const webkit = { name: 'webkit', use: devices['Desktop Safari'] };
const chromium = { name: 'chromium', use: devices['Desktop Chrome'] };

export const sharedConfig = defineConfig({
  testDir: './tests/visual', workers: 1,
  // These tests run on real animation frames and drive up to 200 wheel events,
  // each acknowledged by WebKit before the next. A loaded hosted runner can
  // spend more than the default 30 seconds on that work alone.
  timeout: 90_000,
  reporter: 'line', use: { baseURL, contextOptions: { reducedMotion: 'reduce' } },
  projects: [webkit, chromium],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    env: { VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:8787', VITE_KORDI_DEV_PROFILE: 'community' },
    url: `${baseURL}/tests/visual/transcriptHistory.html`, reuseExistingServer: false,
  },
});

export default defineConfig({
  ...sharedConfig,
  testMatch: ['transcriptHistory.spec.ts', 'transcriptEntry.spec.ts', scrollSpec, 'transcriptEstimateAccuracy.spec.ts', 'transcriptSessionChange.spec.ts', 'transcriptHistoryLoading.spec.ts', 'transcriptHistoryBoundary.spec.ts', 'transcriptHistoryMedia.spec.ts'],
  reporter: process.env.CI ? [['line'], ['./tests/visual/historyRetryReporter.ts']] : 'line',
  // Both partitions keep the same name so --project webkit still runs the full suite.
  projects: [
    { ...webkit, testIgnore: scrollSpec },
    { ...webkit, testMatch: scrollSpec, retries: process.env.CI ? 1 : 0 },
    chromium,
  ],
});
