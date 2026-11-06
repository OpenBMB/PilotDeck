import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PILOTDECK_EDITOR_TEST_PORT || 5193);
export default defineConfig({
  testDir: '.',
  testMatch: 'editor-loading.spec.mjs',
  outputDir: path.join(uiRoot, '../artifacts/editor-loading-playwright'),
  workers: 1,
  timeout: 90000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/support/editor-loading-server.mjs',
    cwd: uiRoot,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
