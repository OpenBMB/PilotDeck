import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../../ui/package.json', import.meta.url))('@playwright/test');
const qa = process.env.BINDING_QA_ROOT; assert.ok(qa);
const env = JSON.parse(readFileSync(join(qa, 'env.json'), 'utf8'));
const projects = JSON.parse(readFileSync(join(qa, 'projects.json'), 'utf8'));
const web = `http://127.0.0.1:${env.SERVER_PORT}`, results = [], errors = [];
const browser = await chromium.launch({ headless: true, channel: process.env.BINDING_QA_BROWSER_CHANNEL || 'chrome' });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => localStorage.setItem('auth-token', 'binding-local-bypass'));
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  let release, pending;
  const delayed = new Promise(done => pending = done), gate = new Promise(done => release = done);
  let captured = false;
  await page.route('**/api/projects/**/staffdeck-binding', async route => {
    if (captured || !route.request().url().includes(projects.a.name)) return route.continue();
    captured = true;
    const response = await route.fetch();
    pending(); await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.goto(`${web}/p/${projects.a.name}`);
  await delayed;
  await page.locator('.project-expand-button').filter({ hasText: 'ProjectB' }).click();
  await page.getByRole('status').filter({ hasText: 'ProjectB-' }).waitFor({ timeout: 30000 });
  release(); await page.waitForTimeout(500);
  const status = await page.getByRole('status').filter({ hasText: 'StaffDeck:' }).innerText();
  assert.ok(status.includes('ProjectB-')); assert.ok(!status.includes('ProjectA-'));
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.locator('.pilotdeck-knowledge-host').waitFor(); await page.waitForTimeout(500);
  assert.equal(await page.locator('.pilotdeck-knowledge-host').getByText('A general BINDING_MARKER', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(qa, 'browser-late-response.png'), fullPage: true });
  results.push({ id: 'U01-LATE-A-STATUS', status: 'PASS', delayedRealResponse: true, switchedBySidebar: true,
    bStatusPreserved: true, bResourcesIsolated: true, errors });
} catch (error) { results.push({ id: 'U01-LATE-A-STATUS', status: 'FAIL', error: error.message, errors }); process.exitCode = 1; }
finally { await browser.close(); writeFileSync(join(qa, 'browser-switch-result.json'), JSON.stringify(results, null, 2)); }
console.log(JSON.stringify(results));
