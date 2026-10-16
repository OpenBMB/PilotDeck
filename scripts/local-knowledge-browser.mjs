import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../ui/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const output = resolve(process.env.KM_LOCAL_EVIDENCE || 'docs/validation/2026-10-16-local-knowledge');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = { status: 'not_accepted', url: process.env.PD_LOCAL_URL || 'http://127.0.0.1:18920' };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(report.url + '/knowledge');
  const frame = page.frameLocator('iframe[title=Knowledge]');
  await frame.getByText('Upload', { exact: true }).waitFor({ timeout: 20_000 });
  await frame.getByText('Suggestions', { exact: true }).waitFor();
  report.knowledge = await frame.locator('body').innerText();
  assert.match(report.knowledge, /Local knowledge/);
  await page.screenshot({ path: join(output, 'pd-managed-km.png'), fullPage: true });
  report.status = 'passed';
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  await browser.close();
  await writeFile(join(output, 'browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
