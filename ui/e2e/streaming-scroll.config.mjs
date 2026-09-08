import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export default defineConfig({
  testDir: '.',
  testMatch: ['streaming-scroll.spec.mjs', 'streaming-lifecycle.spec.mjs', 'streaming-search.spec.mjs'],
  outputDir: '/tmp/pilotdeck-stream-playwright',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5179', viewport: { width: 1100, height: 800 }, screenshot: 'only-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5179 --strictPort',
    cwd: uiRoot,
    url: 'http://127.0.0.1:5179/e2e/fixtures/streaming-scroll.html',
    reuseExistingServer: false,
  },
});
