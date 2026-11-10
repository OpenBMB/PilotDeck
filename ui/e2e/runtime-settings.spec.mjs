import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Route fixtures must own their API responses instead of the app's PWA worker.
test.use({ channel: process.env.PILOTDECK_TEST_BROWSER_CHANNEL, serviceWorkers: 'block' });
for (const language of ['en', 'zh-CN']) test(`Git and Python status, manual checks and timeout recovery: ${language}`, async ({ page, context }, info) => {
  test.setTimeout(90000);
  const text = JSON.parse(await readFile(new URL(`../src/i18n/locales/${language}/settings.json`, import.meta.url), 'utf8'));
  await context.addInitScript(language => localStorage.setItem('userLanguage', language), language);
  let reads = 0, checks = 0;
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  let release;
  const config = { agent: { model: 'test/model' } };
  await context.routeWebSocket('**/ws**', socket => socket.onMessage(() => {}));
  await context.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body = {};
    if (pathname === '/api/auth/status') body = { authDisabled: true };
    else if (pathname === '/api/config') body = { exists: true, path: '/fixture/pilotdeck.yaml', raw: JSON.stringify(config), config, revision: '1', validation: { valid: true, errors: [], warnings: [] } };
    else if (pathname === '/api/settings/general-workspace') body = { directory: '', effectiveDirectory: '/fixture/general', defaultDirectory: '/fixture/general' };
    else if (pathname === '/api/config/python-runtime') { reads++; body = { enabled: true, state: 'available', version: '3.12.16', executable: '/fixture/base/python', packages: { requests: '2' } }; }
    else if (pathname === '/api/config/python-runtime/check') {
      expect(route.request().method()).toBe('POST'); checks++;
      if (checks === 1) await new Promise(resolve => { release = resolve; });
      body = { enabled: true, state: 'ready', version: '3.12.16', executable: '/fixture/verified/python', packages: { requests: '2' } };
    } else if (pathname === '/api/config/git-runtime') body = { state: 'ready', source: 'bundled', version: '2.51.2', executable: '/fixture/git/cmd/git.exe' };
    else if (pathname === '/api/projects') body = [];
    else if (pathname.includes('onboarding-status')) body = { hasCompletedOnboarding: true };
    else if (pathname.includes('providers') || pathname.includes('models')) body = { providers: [], models: [] };
    else if (pathname.includes('sessions')) body = { sessions: [], total: 0, hasMore: false };
    else if (pathname.includes('tasks')) body = { tasks: [] };
    else if (pathname.includes('skills') || pathname.includes('plugins')) body = { skills: [], plugins: [] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(error => {
      if (!/canceled|closed|Invalid InterceptionId/i.test(error.message)) throw error;
    });
  });
  try {
    await page.goto('/settings/advanced');
    await expect(page.getByText('/fixture/base/python', { exact: true })).toBeVisible({ timeout: 60000 });
    expect(browserErrors).toEqual([]);
    await expect(page.getByText('/fixture/git/cmd/git.exe', { exact: true })).toBeVisible();
    await expect(page.getByText(text.gitRuntime.sources.bundled, { exact: true })).toBeVisible();
    const python = page.getByRole('region', { name: text.pythonRuntime.title, exact: true });
    const git = page.getByRole('region', { name: text.gitRuntime.title, exact: true });
    expect((await python.boundingBox()).y).toBeLessThan((await git.boundingBox()).y);
    const initialReads = reads;
    await page.clock.install(); await page.clock.fastForward(60_000);
    expect(reads).toBe(initialReads); expect(checks).toBe(0);
    const check = python.getByRole('button', { name: text.pythonRuntime.refresh, exact: true });
    await check.click(); await expect.poll(() => checks).toBe(1);
    await page.clock.fastForward(91_000);
    await expect(python.getByRole('status')).toContainText(text.pythonRuntime.statusTimedOut);
    await expect(check).toBeEnabled(); release();
    await check.click();
    await expect(page.getByText('/fixture/verified/python', { exact: true })).toBeVisible();
    expect(checks).toBe(2);
    await page.screenshot({ path: info.outputPath(`runtime-settings-${language}.png`), fullPage: true });
  } catch (error) {
    await info.attach('runtime-settings-errors', { body: JSON.stringify({ browserErrors, reads, checks }), contentType: 'application/json' });
    throw error;
  } finally { release?.(); }
});
