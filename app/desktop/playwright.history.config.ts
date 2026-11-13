import { defineConfig, devices } from '@playwright/test';
import process from 'node:process';

const port = Number(process.env.KORDI_HISTORY_TEST_PORT ?? 62358);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './tests/visual', testMatch: ['transcriptHistory.spec.ts', 'transcriptEntry.spec.ts', 'transcriptHistoryScrollStability.spec.ts', 'transcriptEstimateAccuracy.spec.ts', 'transcriptSessionChange.spec.ts', 'transcriptHistoryLoading.spec.ts', 'transcriptHistoryBoundary.spec.ts', 'transcriptHistoryMedia.spec.ts'], workers: 1,
  // These tests run on real animation frames and drive up to 200 wheel events,
  // each acknowledged by WebKit before the next. A loaded hosted runner can
  // spend more than the default 30 seconds on that work alone.
  timeout: 90_000,
  reporter: 'line', use: { baseURL, reducedMotion: 'reduce' },
  projects: [
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    env: { VITE_KORDI_CLOUD_API_BASE: 'http://127.0.0.1:8787', VITE_KORDI_DEV_PROFILE: 'community' },
    url: `${baseURL}/tests/visual/transcriptHistory.html`, reuseExistingServer: false,
  },
});
