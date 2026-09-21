import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'composition.spec.mjs',
  outputDir: '../test-results/composition',
  use: { baseURL: process.env.COMPOSITION_URL ?? 'http://127.0.0.1:5187', headless: true },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
