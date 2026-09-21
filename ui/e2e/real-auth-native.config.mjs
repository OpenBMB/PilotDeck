import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'real-auth-native.spec.mjs',
  outputDir: '../test-results/real-auth-native',
  reporter: [['list'], ['html', { outputFolder: '../test-results/real-auth-native-report', open: 'never' }]],
  use: {
    baseURL: process.env.REAL_NATIVE_URL || 'http://127.0.0.1:15100',
    headless: true,
    trace: 'on',
    screenshot: 'only-on-failure',
  },
});
