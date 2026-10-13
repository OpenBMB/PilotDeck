import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../ui/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const qa = process.env.BINDING_QA_ROOT; assert.ok(qa, 'Set BINDING_QA_ROOT');
const env = JSON.parse(readFileSync(join(qa, 'env.json'), 'utf8'));
const projects = JSON.parse(readFileSync(join(qa, 'projects.json'), 'utf8'));
const origin = `http://127.0.0.1:${env.SERVER_PORT}`;
const browser = await chromium.launch({ headless: true, channel: process.env.BINDING_QA_BROWSER_CHANNEL || 'chrome' });
const errors = [], results = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => localStorage.setItem('auth-token', 'binding-local-bypass'));
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/p/${projects.a.name}`);
  await page.getByRole('status').filter({ hasText: 'Connected' }).waitFor({ timeout: 30000 });
  assert.ok((await page.getByRole('status').filter({ hasText: 'StaffDeck:' }).innerText()).includes('ProjectA-'));
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  const host = page.locator('.pilotdeck-knowledge-host');
  await host.getByText('A general BINDING_MARKER', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 30000 });
  await host.getByText('A sop_specific BINDING_MARKER', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 30000 });
  await page.screenshot({ path: join(qa, 'desktop-a.png'), fullPage: true });
  const second = await context.newPage(); second.on('pageerror', error => errors.push(error.message));
  await second.goto(`${origin}/p/${projects.b.name}`);
  await second.getByRole('status').filter({ hasText: 'ProjectB-' }).waitFor({ timeout: 30000 });
  await second.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await second.locator('.pilotdeck-knowledge-host').waitFor({ timeout: 30000 });
  await second.waitForTimeout(1000);
  assert.equal(await second.locator('.pilotdeck-knowledge-host').getByText('A general BINDING_MARKER', { exact: true }).count(), 0);
  assert.ok((await page.getByRole('status').filter({ hasText: 'StaffDeck:' }).innerText()).includes('ProjectA-'));
  await second.setViewportSize({ width: 390, height: 844 });
  assert.ok(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await second.screenshot({ path: join(qa, 'mobile-b.png'), fullPage: true });
  assert.equal(await page.getByText('Reconnecting...', { exact: true }).count(), 0);
  assert.equal(await second.getByText('Reconnecting...', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  results.push({ id: 'U01/U02', status: 'PASS', aVisible: true, bEmpty: true, tabsIsolated: true,
    desktop: [1440, 960], mobile: [390, 844], errors });
} catch (error) { results.push({ id: 'U01/U02', status: 'FAIL', error: error.message, errors }); process.exitCode = 1; }
finally { writeFileSync(join(qa, 'browser-result.json'), JSON.stringify(results, null, 2)); await browser.close(); }
console.log(JSON.stringify(results));
