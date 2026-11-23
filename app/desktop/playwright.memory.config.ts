import { defineConfig } from '@playwright/test';
import { sharedConfig } from './playwright.history.config';
export default defineConfig({ ...sharedConfig, testMatch: 'reactPerformanceRetention.spec.ts' });
