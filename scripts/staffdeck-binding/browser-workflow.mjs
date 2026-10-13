import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const pd = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(new URL('../../ui/package.json', import.meta.url))('@playwright/test');
const qa = process.env.BINDING_QA_ROOT; assert.ok(qa);
const env = JSON.parse(readFileSync(join(qa, 'env.json'), 'utf8'));
const web = `http://127.0.0.1:${env.SERVER_PORT}`, results = [], errors = [], network = [];
const label = process.env.BINDING_QA_RUN_LABEL || String(Date.now());
assert.match(label, /^[a-zA-Z0-9_-]+$/);
const browser = await chromium.launch({ headless: true, channel: process.env.BINDING_QA_BROWSER_CHANNEL || 'chrome' });
function restartSD() {
  const value = spawnSync(process.execPath, [join(pd, 'scripts/staffdeck-binding/restart.mjs'), 'sd'], {
    cwd: pd, env: { ...process.env, BINDING_QA_ROOT: qa, NODE_OPTIONS: '' }, encoding: 'utf8' });
  assert.equal(value.status, 0, 'SD restart failed');
}
async function readySD() {
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(env.STAFFDECK_FORMAL_API_ORIGIN + '/api/health', { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error('SD unavailable');
}
async function readyWeb() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(web + '/api/auth/status', { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error('Web unavailable');
}
try {
  await readyWeb();
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => localStorage.setItem('auth-token', 'binding-local-bypass'));
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.url().includes('/api/modules/') || response.url().includes('create-workspace'))
    network.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  await page.goto(web);
  await page.getByRole('button', { name: 'Create new project', exact: true }).click();
  const name = `BrowserQA${Date.now()}`, path = join(qa, 'workspace', name);
  await page.locator('.workspace-simple-form input[type=text]').fill(path);
  const pids = JSON.parse(readFileSync(join(qa, 'pids.json'), 'utf8'));
  process.kill(pids.sd, 'SIGTERM');
  await new Promise(done => setTimeout(done, 500));
  const [creation] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/projects/create-workspace')),
    page.getByRole('button', { name: 'Create workspace', exact: true }).click(),
  ]);
  const created = (await creation.json()).project;
  assert.equal(created.staffdeckBinding.status, 'failed');
  await page.goto(`${web}/p/${created.name}`);
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  await page.screenshot({ path: join(qa, 'browser-failure.png'), fullPage: true });
  restartSD(); await readySD();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'StaffDeck: Connected' }).waitFor({ timeout: 30000 });
  await page.reload();
  await page.getByRole('status').filter({ hasText: 'StaffDeck: Connected' }).waitFor({ timeout: 30000 });
  results.push({ id: 'U01/U02-CREATE-RETRY', status: 'PASS', project: created.name,
    originalBindingId: created.staffdeckBinding.bindingId, failedProjectRetained: true, refreshRestored: true });
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: /create knowledge base/i }).click();
  const marker = 'BROWSER_UPLOAD_BINDING_4812';
  await page.locator('input[type=file]').setInputFiles({ name: 'Browser marker.md', mimeType: 'text/markdown',
    buffer: Buffer.from(`# Browser marker\n\n${marker}`) });
  for (let i = 0; i < 120; i++) {
    const response = await context.request.post(`${web}/api/modules/knowledge/call`, {
      headers: { 'X-PilotDeck-Project': created.name }, data: { operation: 'query', input: { query: 'Browser marker', mode: 'chat' } } });
    if (response.ok() && JSON.stringify(await response.json()).includes(marker)) break;
    if (i === 119) throw new Error('Browser upload did not produce searchable content');
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: join(qa, 'browser-upload.png'), fullPage: true });
  results.push({ id: 'U02-KNOWLEDGE-UPLOAD', status: 'PASS', marker, actualIngestionAndQuery: true });
  const sopId = `browser_sop_${Date.now()}`;
  const draftResponse = await context.request.post(`${web}/api/modules/sop/management/call`, {
    headers: { 'X-PilotDeck-Project': created.name }, data: { operation: 'create', input: { content: {
      skill_id: sopId, name: 'Browser publication QA', version: '1.0.0', nodes: [{ node_id: 'answer', type: 'response',
        name: 'Answer', instruction: 'Return browser publication marker then complete' }], edges: [], start_node_id: 'answer', terminal_node_ids: ['answer'] } } } });
  assert.ok(draftResponse.ok());
  await page.getByRole('button', { name: 'Workflow', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: sopId });
  await row.getByRole('button', { name: 'SOP actions' }).click();
  const [publication] = await Promise.all([
    page.waitForResponse(response => {
      if (!response.url().includes('/api/modules/') || response.request().method() !== 'POST') return false;
      try { return ['publish', 'publish_sop'].includes(response.request().postDataJSON()?.operation); }
      catch { return false; }
    }, { timeout: 30000 }),
    page.getByRole('menuitem', { name: /^enable(?: local version)?$/i }).click(),
  ]);
  assert.ok(publication.ok(), `Publication returned ${publication.status()}`);
  await row.getByText('Enabled', { exact: true }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: join(qa, 'browser-published.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(qa, 'browser-workflow-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  results.push({ id: 'U02-SOP-PUBLISH', status: 'PASS', sopId, draftSeed: 'real management API',
    publication: 'browser action', viewports: [[1440, 960], [390, 844]] });
  await page.setViewportSize({ width: 1440, height: 960 });
  await row.getByRole('button', { name: 'SOP actions' }).click();
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/modules/')
      && response.request().method() === 'POST' && response.request().postDataJSON()?.operation === 'archive'),
    page.getByRole('menuitem', { name: /^disable(?: local version)?$/i }).click(),
  ]);
  await row.getByText('Disabled', { exact: true }).first().waitFor();
  assert.equal(await page.getByText(`${sopId} / 1.0.0`, { exact: true }).count(), 0);
  await page.reload();
  await page.getByRole('button', { name: 'Workflow', exact: true }).click();
  assert.equal(await page.getByText(`${sopId} / 1.0.0`, { exact: true }).count(), 0);
  results.push({ id: 'U02-SOP-ARCHIVE', status: 'PASS', staleReceiptRemoved: true, persistedAfterRefresh: true });
} catch (error) { results.push({ id: 'U02-WORKFLOW', status: 'FAIL', error: error.message, errors }); process.exitCode = 1; }
finally {
  try { restartSD(); } catch (error) { results.push({ id: 'SD-RESTORE', status: 'FAIL', error: error.message }); process.exitCode = 1; }
  await browser.close();
  writeFileSync(join(qa, `browser-workflow-result-${label}.json`), JSON.stringify({ results, network }, null, 2));
}
console.log(JSON.stringify(results));
