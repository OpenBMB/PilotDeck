// Run against Vite with isolated API responses and synthetic memory only.
import { chromium, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
const styles = (element, keys) => Object.fromEntries(keys.map(key => [key, getComputedStyle(element)[key]]));
const cardKeys = ['borderRadius', 'backgroundColor', 'borderColor', 'boxShadow'];
const fieldKeys = ['height', 'borderRadius', 'fontSize'];
export const memoryScheduleCases = [['en', 'light', 'default', 1440], ['zh-CN', 'dark', 'blue', 1440], ['en', 'light', 'mint', 390], ['zh-CN', 'dark', 'gray', 390]];
export async function verifyMemoryScheduleSettings({ browser, base, output, cases = memoryScheduleCases }) {
 await mkdir(output, { recursive: true });
 for (const [language, mode, preset, width] of cases) {
  const translations = JSON.parse(await readFile(new URL(`../src/i18n/locales/${language}/settings.json`, import.meta.url), 'utf8'));
  const text = translations.pilotDeckConfig.panels, actions = translations.settingsPage.actions;
  const common = JSON.parse(await readFile(new URL(`../src/i18n/locales/${language}/alwaysOn.json`, import.meta.url), 'utf8'));
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(({language,mode,preset}) => {
   localStorage.setItem('userLanguage', language); localStorage.setItem('themeMode', mode);
   localStorage.setItem('pilotdeck-light-appearance-v1', JSON.stringify({ preset }));
  }, { language, mode, preset });
  let config = { agent: { model: 'fixture/test' }, model: { providers: { fixture: { protocol: 'openai', url: 'https://example.invalid/v1', models: { test: {} } } } }, memory: { enabled: true, autoIndexIntervalMinutes: 60, autoDreamIntervalMinutes: 120 }, cron: { enabled: true, timezone: 'UTC', maxConcurrentRuns: 2 } };
  let revision = 1; const requests = [], errors = [];
  await context.route('**/api/**', async route => {
   const request = route.request(), url = new URL(request.url()), p = url.pathname;
   let body = {};
   if (p === '/api/auth/status') body = { authDisabled: true };
   else if (p === '/api/config') {
    if (request.method() === 'PUT') { config = parse(request.postDataJSON().raw); revision++; }
    body = { exists: true, raw: JSON.stringify(config), config, revision: String(revision), validation: { valid: true, errors: [], warnings: [] } };
   } else if (p === '/api/settings/general-workspace') body = { directory: '', effectiveDirectory: '/fixture/general', defaultDirectory: '/fixture/general' };
   else if (p === '/api/projects') body = [{ name: 'demo', displayName: 'Fixture', fullPath: '/fixture/demo', kind: 'workspace', sessions: [], capabilities: { files: true } }];
   else if (p.includes('onboarding-status')) body = { hasCompletedOnboarding: true };
   else if (p.includes('providers') || p.includes('models')) body = { providers: [], models: [] };
   else if (p.includes('sessions')) body = { sessions: [], hasMore: false, total: 0 };
   else if (p.includes('tasks')) body = { tasks: [] };
   else if (p.includes('skills') || p.includes('plugins')) body = { skills: [], plugins: [] };
   else if (p.includes('/cron')) body = { jobs: [] };
   else if (p.includes('/memory/')) { requests.push({ path: p, query: url.searchParams.toString(), method: request.method(), body: request.method() === 'POST' ? request.postDataJSON() : null }); body = { memories: [], projects: [], items: [], total: 0 }; }
   await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await context.routeWebSocket('**/ws**', socket => socket.onMessage(() => {}));
  await context.route('**/memory-dashboard/**', async route => {
   const name = new URL(route.request().url()).pathname.slice('/memory-dashboard/'.length);
   if (!['index.html','app.css','app.js','trace-i18n.js','assets/brand/logo.png'].includes(name)) return route.fulfill({status:404,body:''});
   const body = await readFile(new URL('../../src/context/memory/edgeclaw-memory-core/ui-source/' + name, import.meta.url));
   await route.fulfill({ body, contentType: name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'application/javascript' : name.endsWith('.png') ? 'image/png' : 'text/html' });
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  const go = async route => { await page.goto(base + route); await expect(page.locator('.pd-startup-screen')).toHaveCount(0, { timeout: 60000 }); };
  await go('/settings/general');
  const card = await page.locator('.general-card').first().evaluate(styles, cardKeys);
  const field = await page.locator('.general-select-wrap select').first().evaluate(styles, fieldKeys);
  await go('/settings/agent-memory');
  await expect(page.locator('.memory-page-content > section:not(.memory-data-section), .memory-data-section > div')).toHaveCount(3);
  for (const panel of await page.locator('.memory-page-content > section:not(.memory-data-section), .memory-data-section > div').all()) expect(await panel.evaluate(styles, cardKeys)).toEqual(card);
  const interval = page.locator('#memory-indexing-value');
  const row = interval.locator('xpath=../..');
  await expect(interval).toBeDisabled();
  await row.getByRole('button', { name: actions.edit, exact: true }).click();
  expect(await interval.evaluate(styles, fieldKeys)).toEqual(field);
  await interval.fill('7'); await row.getByRole('button', { name: actions.cancel, exact: true }).click();
  expect(config.memory.autoIndexIntervalMinutes).toBe(60);
  await row.getByRole('button', { name: actions.edit, exact: true }).click();
  await interval.fill('2'); await page.locator('#memory-indexing-unit').selectOption('hours');
  await row.getByRole('button', { name: actions.save, exact: true }).click();
  await expect.poll(() => config.memory.autoIndexIntervalMinutes).toBe(120);
  await page.locator('#memory-project').selectOption('demo');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: text.memory.data.actions.export, exact: true }).click(); await download;
  expect(requests.at(-1)).toMatchObject({ path: '/api/memory/export/current-project', query: 'projectPath=%2Ffixture%2Fdemo' });
  const [fileChooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: text.memory.data.actions.import, exact: true }).press('Enter')]);
  await fileChooser.setFiles({ name: 'memory.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ memories: [] })) });
  await page.getByRole('dialog').getByRole('button').last().click();
  await expect.poll(() => requests.at(-1)?.path).toBe('/api/memory/import/current-project');
  expect(requests.at(-1)).toMatchObject({ method: 'POST', query: 'projectPath=%2Ffixture%2Fdemo', body: { memories: [] } });
  await page.getByRole('button', { name: text.memory.data.actions.clear, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: text.memory.data.confirm.clearModalConfirm, exact: true }).click();
  await expect.poll(() => requests.at(-1)?.body?.scope).toBe('current_project');
  expect(requests.at(-1).body.projectPath).toBe('/fixture/demo');
  await page.screenshot({ path: path.join(output, `${language}-${mode}-${width}-memory.png`), fullPage: true });
  await go('/settings/agent-schedule');
  for (const panel of await page.locator('.scheduled-page-content > section').all()) expect(await panel.evaluate(styles, cardKeys)).toEqual(card);
  const concurrency = page.locator('#scheduled-concurrency'), concurrencyRow = concurrency.locator('xpath=../..');
  await concurrencyRow.getByRole('button', { name: actions.edit, exact: true }).click();
  expect(await concurrency.evaluate(styles, fieldKeys)).toEqual(field);
  await concurrency.fill('0'); await expect(concurrencyRow.getByRole('button', { name: actions.save, exact: true })).toBeDisabled();
  await concurrency.fill('21'); await expect(concurrencyRow.getByRole('button', { name: actions.save, exact: true })).toBeDisabled();
  await concurrency.fill('3'); await concurrencyRow.getByRole('button', { name: actions.save, exact: true }).click();
  await expect.poll(() => config.cron.maxConcurrentRuns).toBe(3);
  const timezone = page.locator('#scheduled-timezone'), timezoneRow = timezone.locator('xpath=../../..');
  await timezoneRow.getByRole('button', { name: actions.edit, exact: true }).click();
  await timezone.selectOption('Asia/Tokyo'); await timezoneRow.getByRole('button', { name: actions.cancel, exact: true }).click();
  expect(config.cron.timezone).toBe('UTC');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.screenshot({ path: path.join(output, `${language}-${mode}-${width}-schedule.png`), fullPage: true });
  if (width > 1000) {
   await go('/cron'); await page.getByRole('button', { name: common.cron.tabs.create, exact: true }).click();
   const workspace = page.getByRole('combobox', { name: common.cron.create.fields.workspace, exact: true });
   expect(await workspace.evaluate(styles, fieldKeys)).toEqual(field);
   await workspace.selectOption('/fixture/demo');
   const date = page.getByLabel(common.cron.create.fields.date, { exact: true });
   expect(await date.evaluate(styles, fieldKeys)).toEqual(field);
   await page.screenshot({ path: path.join(output, language + '-' + mode + '-cron-create.png') });
   await go('/p/demo'); await expect(page.locator('.workspace-header')).toBeVisible();
   await page.locator('.workspace-header button[aria-haspopup=menu]').click();
   await page.getByRole('menuitem', { name: /Memory|记忆/ }).click();
   const memory = page.frameLocator('iframe');
   await expect(memory.locator('#pilotdeck-memory-controls')).toBeAttached({timeout:30000});
   const hostTokens = await page.evaluate(async ({ preset, mode }) => {
    const { deriveAppearanceColors, normalizeLightAppearance } = await import('/src/lib/lightAppearance.ts');
    const colors = deriveAppearanceColors(normalizeLightAppearance({ preset }), mode === 'dark');
    return [colors.surface, colors.accent];
   }, { preset, mode });
   await expect.poll(() => memory.locator('html').evaluate(el => ['--bg','--accent']
    .map(key => getComputedStyle(el).getPropertyValue(key).trim()))).toEqual(hostTokens);
   await memory.locator('[data-page=trace]').click();
   const choice = memory.locator('#recallCaseSelect');
   await expect(choice).toBeVisible(); await expect(choice).toHaveCSS('appearance', 'base-select');
   await choice.click(); await expect.poll(() => choice.evaluate(el => el.matches(':open'))).toBe(true);
   const popupBackground = await choice.evaluate(el => getComputedStyle(el, '::picker(select)').backgroundColor);
   expect(popupBackground).toBe(await memory.locator('html').evaluate(el => {
    const test = document.createElement('span'); test.style.background = 'var(--pd-elevated)'; el.append(test);
    const result = getComputedStyle(test).backgroundColor; test.remove(); return result;
   }));
   await page.screenshot({path:path.join(output,language + '-' + mode + '-memory-picker.png')});
   await page.keyboard.press('Escape');
  }
  expect(errors).toEqual([]); await context.close();
  console.log(`PASS: ${language}/${mode}/${preset}/${width} shared styles, interval save/cancel, scoped memory actions and schedule validation`);
 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const browser = await chromium.launch({ channel: process.env.PILOTDECK_TEST_BROWSER_CHANNEL || 'chrome', headless: true });
 try { await verifyMemoryScheduleSettings({ browser, base: process.env.PILOTDECK_SMOKE_URL || 'http://127.0.0.1:5187', output: path.resolve('artifacts/settings-consistency') }); }
 finally { await browser.close(); }
}
