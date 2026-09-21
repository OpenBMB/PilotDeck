import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /formal-(composition|route-matrix)\.spec\.mjs/,
  outputDir: '../test-results/formal-composition',
  reporter: [['list'], ['html', { outputFolder: '../test-results/formal-composition-report', open: 'never' }]],
  use: {
    baseURL: process.env.FORMAL_COMPOSITION_URL || 'http://127.0.0.1:5188',
    headless: true,
    trace: 'on',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
