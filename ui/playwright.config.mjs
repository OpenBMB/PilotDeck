import { defineConfig } from '@playwright/test';

const baseURL = process.env.PILOTDECK_E2E_BASE_URL;
if (!baseURL) {
  throw new Error('PILOTDECK_E2E_BASE_URL is required. Run Playwright through `pnpm e2e`.');
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  outputDir: 'test-results/playwright',
});
