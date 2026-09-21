import { defineConfig } from '@playwright/test';

const profile = process.env.REAL_COMPOSITION_PROFILE || 'composition';

export default defineConfig({
  testDir: '.',
  testMatch: 'real-auth-composition.spec.mjs',
  outputDir: `../test-results/real-auth-${profile}`,
  reporter: [['list'], ['html', { outputFolder: `../test-results/real-auth-${profile}-report`, open: 'never' }]],
  use: {
    baseURL: process.env.REAL_COMPOSITION_URL || 'http://127.0.0.1:15101',
    headless: true,
    trace: 'on',
    screenshot: 'only-on-failure',
  },
});
