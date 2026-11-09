import { test as browserTest, expect, _electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export { expect };
export const test = process.env.PILOTDECK_SCROLL_ELECTRON === '1' ? browserTest.extend({
  page: async ({}, use) => {
    const profile = await mkdtemp(path.join(tmpdir(), 'pilotdeck-scroll-'));
    let app;
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|DISPLAY|XAUTHORITY|HOME|LANG)$/i.test(key)));
      app = await _electron.launch({
        executablePath: createRequire(import.meta.url)(path.join(root, 'apps/desktop/node_modules/electron')),
        args: [path.join(root, 'ui/e2e/fixtures/scroll-electron.cjs')],
        env: { ...env, PILOTDECK_SCROLL_PROFILE: profile },
      });
      await use(await app.firstWindow());
    } finally {
      await app?.close();
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
}) : browserTest;
