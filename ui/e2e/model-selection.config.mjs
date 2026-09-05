import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export default defineConfig({
  testDir: '.', testMatch: ['model-selection.spec.mjs'], outputDir: '/tmp/pilotdeck-model-selection-playwright', workers: 1,
  use: { baseURL: 'http://127.0.0.1:5180', viewport: { width: 1100, height: 800 }, screenshot: 'only-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5180 --strictPort', cwd: uiRoot,
    url: 'http://127.0.0.1:5180/e2e/fixtures/model-selection.html', reuseExistingServer: false },
});
