import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installEditorFixture, initialText } from './support/editor-loading-fixture.mjs';

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(process.env.PILOTDECK_EDITOR_BUILD_DIR || path.join(uiRoot, 'dist'));
const expectLazy = process.env.PILOTDECK_EDITOR_EXPECT_LAZY !== '0';
const editorSource = 'src/components/code-editor/view/CodeEditor.tsx';
const pdfSource = 'src/components/code-editor/view/subcomponents/PdfDocumentPreview.tsx';

test('production chat defers editors while text drafts and PDF navigation remain functional', async ({ page, baseURL }, testInfo) => {
  const manifest = JSON.parse(await fs.readFile(path.join(dist, '.vite/manifest.json'), 'utf8'));
  const requested = new Set();
  const errors = [];
  const snapshots = {};
  page.on('request', request => requested.add(new URL(request.url()).pathname.replace(/^\//, '')));
  page.on('pageerror', error => errors.push(error.message));
  const codeMirrorFiles = Object.entries(manifest).filter(([key, chunk]) =>
    /(?:^|\/)vendor-codemirror(?:-|\.)/.test(chunk.file) || /^_?vendor-codemirror(?:-|\.)/.test(key)).map(([, chunk]) => chunk.file);
  expect(codeMirrorFiles.length).toBeGreaterThan(0);
  const sawCodeMirror = () => codeMirrorFiles.some(file => requested.has(file));
  const sawPdf = () => [...requested].some(file => /(?:^|\/)(?:PdfDocumentPreview-|pdf(?:\.worker)?[.-])/.test(file));
  const { textFiles, foreignRequests } = await installEditorFixture(page, baseURL);
  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.pd-startup-screen')).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    snapshots.chat = [...requested].sort();
    if (expectLazy) {
      expect(sawCodeMirror(), 'Chat must not request the editor runtime').toBe(false);
      expect(manifest[editorSource], 'Editor must have its own lazy entry').toBeTruthy();
      expect(manifest[pdfSource], 'PDF must have its own lazy entry').toBeTruthy();
      expect(requested.has(manifest[editorSource].file)).toBe(false);
      expect(sawPdf()).toBe(false);
    } else expect(sawCodeMirror(), 'Baseline captures the intentional eager-loading difference').toBe(true);

    await page.locator('.workspace-actions').getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('navigation', { name: 'Workbench panels' }).getByRole('button', { name: 'Files', exact: true }).click();
    await expect(page.getByText('first.ts', { exact: true })).toBeVisible();
    if (expectLazy) {
      expect(sawCodeMirror(), 'Browsing the file tree must not open an editor').toBe(false);
      expect(requested.has(manifest[editorSource].file)).toBe(false);
    }
    await page.getByText('first.ts', { exact: true }).click();
    const editor = page.locator('.cm-content:visible');
    await expect(editor).toContainText(initialText.trim());
    expect(sawCodeMirror()).toBe(true);
    if (expectLazy) {
      expect(requested.has(manifest[editorSource].file)).toBe(true);
      expect(sawPdf()).toBe(false);
    }
    snapshots.textEditor = [...requested].sort();
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('// unsaved synthetic edit');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await expect(page.getByRole('tab', { name: /first.ts/ }).getByLabel('Modified')).toBeVisible();
    await page.getByText('second.ts', { exact: true }).click();
    await expect(page.locator('.cm-content:visible')).toContainText('export const second = true;');
    await page.getByRole('tab', { name: /first.ts/ }).click();
    await expect(page.locator('.cm-content:visible')).toContainText('// unsaved synthetic edit');
    expect(textFiles.get('first.ts')).toBe(initialText);

    await page.getByText('sample.pdf', { exact: true }).click();
    await expect(page.locator('[data-pdf-page-number="1"] canvas').first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('textbox', { name: 'Go to page', exact: true })).toBeEnabled();
    if (expectLazy) expect(requested.has(manifest[pdfSource].file)).toBe(true);
    expect(sawPdf()).toBe(true);
    const pageNumber = page.getByRole('textbox', { name: 'Go to page', exact: true });
    await pageNumber.fill('2');
    await pageNumber.press('Enter');
    await expect(pageNumber).toHaveValue('2');
    await expect(page.locator('[data-pdf-page-number="2"] canvas').first()).toBeVisible();
    await expect(page.locator('[data-pdf-page-number="2"]')).toBeInViewport({ ratio: 0.5 });
    const zoom = page.getByRole('textbox', { name: 'Zoom percentage', exact: true });
    const previousZoom = Number.parseInt(await zoom.inputValue(), 10);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect.poll(async () => Number.parseInt(await zoom.inputValue(), 10)).toBeGreaterThan(previousZoom);
    await expect(page.locator('[data-pdf-page-number="2"] canvas').first()).toBeVisible();
    snapshots.pdf = [...requested].sort();
    await page.getByRole('tab', { name: /first.ts/ }).click();
    await expect(page.locator('.cm-content:visible')).toContainText('// unsaved synthetic edit');
    expect(foreignRequests, 'Production renderer must use only this isolated fixture server').toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    const evidence = testInfo.outputPath('production-request-stages.json');
    await fs.writeFile(evidence, JSON.stringify({ expectLazy, snapshots, errors, foreignRequests }, null, 2));
    await testInfo.attach('production-request-stages', { path: evidence, contentType: 'application/json' });
  }
});
