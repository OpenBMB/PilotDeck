import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export default defineConfig({
  testDir: '.',
  testMatch: 'editor-tabs.spec.mjs',
  outputDir: '/tmp/pilotdeck-editor-tabs-playwright',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5188', viewport: { width: 1200, height: 800 }, screenshot: 'only-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5188 --strictPort',
    cwd: uiRoot,
    url: 'http://127.0.0.1:5188/e2e/fixtures/editor-tabs.html',
    reuseExistingServer: false,
  },
});
