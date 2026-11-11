import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export default defineConfig({
  testDir: '.',
  testMatch: ['onboarding-workspace.spec.mjs', 'chat-navigation.spec.mjs', 'streaming-scroll.spec.mjs', 'chat-media-scroll.spec.mjs', 'streaming-lifecycle.spec.mjs', 'streaming-search.spec.mjs', 'reasoning-status.spec.mjs', 'process-transitions.spec.mjs', 'chat-process-updates.spec.mjs', 'conversation-turn-nav.spec.mjs', 'history-loading.spec.mjs', 'settings-consistency.spec.mjs', 'runtime-settings.spec.mjs'],
  outputDir: path.join(uiRoot, '../artifacts/stream-playwright'),
  workers: 1,
  use: { channel: process.env.PILOTDECK_TEST_BROWSER_CHANNEL || undefined, baseURL: process.env.PILOTDECK_SCROLL_BASE_URL || 'http://127.0.0.1:5179', viewport: { width: 1100, height: 800 }, screenshot: 'only-on-failure' },
  webServer: process.env.PILOTDECK_SCROLL_BASE_URL ? undefined : {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5179 --strictPort',
    cwd: uiRoot,
    url: 'http://127.0.0.1:5179/e2e/fixtures/streaming-scroll.html',
    reuseExistingServer: false,
  },
});
