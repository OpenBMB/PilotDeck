import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { qa, web, label, recorder, python } from './qa.mjs';
python('editor-model.py');
const { chromium } = createRequire(new URL('../../ui/package.json', import.meta.url))('@playwright/test');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const report = recorder('browser-editor');
for (const [width, height] of [[1440, 960], [390, 844]]) await report.check('U02-EDITOR-' + width, async () => {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(() => localStorage.setItem('auth-token', 'binding-local-bypass'));
  const page = await context.newPage(), errors = [], network = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { if (r.url().includes('/api/modules/')) network.push({ path: new URL(r.url()).pathname, status: r.status() }); });
  try {
    await page.goto(web);
    await page.getByRole('button', { name: 'Search current conversation' }).waitFor();
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
    if (width === 390 && !await page.getByRole('button', { name: 'Create new project', exact: true }).isVisible()) {
      await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Create new project', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Create new project', exact: true }).click();
    await page.locator('.workspace-simple-form input[type=text]').fill(join(qa, 'workspace', `Editor${width}${Date.now()}`));
    const [creation] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/projects/create-workspace')),
      page.getByRole('button', { name: 'Create workspace', exact: true }).click()]);
    const project = (await creation.json()).project;
    assert.equal(project.staffdeckBinding.status, 'bound');
    await page.goto(`${web}/p/${project.name}`);
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
    if (width === 390) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
    const workflow = page.getByRole('button', { name: /Workflow/ });
    await workflow.waitFor({ state: 'attached' });
    if (!await workflow.isVisible()) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
    await workflow.click();
    if (width === 390 && await page.getByRole('button', { name: 'Close sidebar', exact: true }).isVisible()) {
      await page.getByRole('button', { name: 'Close sidebar', exact: true }).click({ position: { x: 385, y: 800 } });
    }
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: /Create blank SOP/i }).click();
    await page.getByPlaceholder('Enter or paste the SOP workflow description to organize.').fill('Reply with BROWSER_EDITOR_COMPLETE, then finish.');
    const generation = page.waitForResponse(r => r.url().includes('/staffdeck-sdk/events') && r.url().includes('preview_job_events'), { timeout: 90000 });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const stream = await generation;
    assert.ok(stream.ok(), await stream.text());
    const streamText = await stream.text();
    writeFileSync(join(qa, `browser-editor-stream-${width}-${label}.txt`), streamText);
    assert.match(streamText, /event:\s*complete/, streamText);
    await page.getByRole('button', { name: /全屏查看流程图|View flowchart in fullscreen|Fullscreen/i }).first().click();
    await page.getByRole('button', { name: /AI 修改|AI edit/i }).click();
    await page.locator('[data-flow-node-id]').first().click();
    const inspector = page.locator('aside').filter({ has: page.locator('textarea') });
    await inspector.locator('textarea').first().fill('Reply BROWSER_EDITOR_EDITED and finish.');
    await page.getByRole('button', { name: /退出全屏|Exit fullscreen/i }).click();
    await page.getByRole('button', { name: 'Save Draft', exact: true }).waitFor({ state: 'visible', timeout: 90000 });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Save Draft') && !b.disabled), { timeout: 90000 });
    await page.getByRole('button', { name: 'Show Source Code', exact: true }).click();
    await page.locator('input[value="binding_editor_sop"]').fill(`binding_editor_${width}_${label}`);
    await page.screenshot({ path: join(qa, `browser-editor-source-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Save Draft', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input').first().fill(`Browser editor ${width} ${label}`);
    const [saved] = await Promise.all([page.waitForResponse(r => r.url().includes('/api/modules/') && r.request().method() === 'POST'
      && ['create', 'create_sop_draft'].includes(r.request().postDataJSON()?.operation)), dialog.getByRole('button', { name: 'Save', exact: true }).click()]);
    const saveBody = saved.request().postDataJSON();
    writeFileSync(join(qa, `browser-editor-save-${width}-${label}.json`), JSON.stringify(saveBody, null, 2));
    assert.ok(saved.ok(), `${await saved.text()} input=${JSON.stringify(saveBody)}`);
    assert.ok(JSON.stringify(saveBody).includes('BROWSER_EDITOR_EDITED'));
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    const row = width === 1440 ? page.getByRole('row').filter({ hasText: `Browser editor ${width} ${label}` })
      : page.locator('article').filter({ hasText: `Browser editor ${width} ${label}` });
    await row.getByRole('button', { name: 'SOP actions' }).click();
    const [published] = await Promise.all([page.waitForResponse(r => r.url().includes('/api/modules/') && r.request().method() === 'POST'
      && ['publish', 'publish_sop'].includes(r.request().postDataJSON()?.operation)), page.getByRole('menuitem', { name: /^enable(?: local version)?$/i }).click()]);
    assert.ok(published.ok(), await published.text());
    await row.getByText('Enabled', { exact: true }).waitFor();
    await page.screenshot({ path: join(qa, `browser-editor-published-${width}.png`), fullPage: true });
    await row.getByRole('button', { name: 'SOP actions' }).click();
    const [archived] = await Promise.all([page.waitForResponse(r => r.url().includes('/api/modules/') && r.request().method() === 'POST'
      && ['archive', 'archive_sop'].includes(r.request().postDataJSON()?.operation)), page.getByRole('menuitem', { name: /^disable(?: local version)?$/i }).click()]);
    assert.ok(archived.ok(), await archived.text());
    await row.getByText('Disabled', { exact: true }).first().waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    return { project: project.name, viewport: [width, height], fromBlank: true, generationThroughFormalSD: true,
      saveStatus: saved.status(), publishStatus: published.status(), archiveStatus: archived.status(), errors, network };
  } finally {
    await page.screenshot({ path: join(qa, `browser-editor-final-${width}.png`), fullPage: true }).catch(() => {});
    await context.close();
  }
});
await browser.close();
