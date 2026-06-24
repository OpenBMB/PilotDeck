import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // The forked project uses a custom globalSetup that touches the source
  // session file before each spec run so it stays in the top-5 sidebar list.
  globalSetup: require.resolve('./global-setup.ts'),
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
});