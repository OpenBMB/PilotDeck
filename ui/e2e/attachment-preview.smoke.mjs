// Start Vite on 5175, then run: node ui/e2e/attachment-preview.smoke.mjs
// Generated sample fixtures only. No model, account, or network service required.
import { chromium, expect } from '@playwright/test';
import sharp from 'sharp';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const fixtures = fileURLToPath(new URL('./fixtures/attachments/', import.meta.url));
const artifacts = path.join(tmpdir(), 'pilotdeck-attachment-preview');
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PILOTDECK_TEST_BROWSER_CHANNEL || 'chrome' });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('userLanguage', 'zh-CN'));
  await page.goto('http://127.0.0.1:5175/e2e/fixtures/attachment-preview.html');
  const buffers = await Promise.all(['#e25555', '#526dd8'].map(background =>
    sharp({ create: { width: 600, height: 400, channels: 3, background } }).png().toBuffer()));
  const files = [...buffers, buffers[0]].map(buffer => ({ name: 'image.png', mimeType: 'image/png', buffer }));
  await page.getByLabel('Pick files').setInputFiles(files);
  await expect(page.getByRole('button', { name: '预览 image.png' })).toHaveCount(3);
  await page.getByRole('button', { name: '预览 image.png' }).nth(1).click();
  await expect(page.getByRole('dialog')).toContainText('2 / 3');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog')).toContainText('3 / 3');
  await page.getByLabel('下一个附件', { exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('1 / 3');
  await expect(page.getByRole('dialog').locator('img')).toBeVisible();
  await expect.poll(() => page.getByRole('dialog').locator('img').evaluate(image => image.naturalWidth)).toBe(600);
  await page.screenshot({ path: path.join(artifacts, 'images.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByText('Send test message').click();
  await expect(page.locator('main img')).toHaveCount(3);
  await page.screenshot({ path: path.join(artifacts, 'sent-grid.png') });

  for (const name of ['notes.txt', 'sample.pdf', 'sample.docx', 'sample.pptx', 'sample.xlsx', 'unsupported.zip']) {
    await page.getByLabel('Pick files').setInputFiles(path.join(fixtures, name));
    await page.getByRole('button', { name: '预览 ' + name, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    if (name === 'notes.txt') await expect(dialog.locator('pre')).toContainText('中文文本预览');
    if (name.endsWith('.pdf')) await expect(dialog.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    if (name.endsWith('.docx')) await expect(dialog.getByText('DOCX preview lifecycle check.')).toBeVisible({ timeout: 60_000 });
    if (name.endsWith('.pptx')) await expect(dialog.getByTestId('pptx-builtin-preview').getByText('PPTX preview lifecycle check', { exact: true })).toBeVisible({ timeout: 60_000 });
    if (name.endsWith('.xlsx')) {
      await expect(dialog.getByRole('cell', { name: 'Attachment', exact: true })).toBeVisible({ timeout: 60_000 });
      await dialog.getByRole('button', { name: 'Second', exact: true }).click();
      await expect(dialog.getByRole('cell', { name: 'Another sheet', exact: true })).toBeVisible();
    }
    if (name.endsWith('.zip')) await expect(dialog).toContainText('此文件暂不支持预览');
    await page.screenshot({ path: path.join(artifacts, name + '.png') });
    await page.getByLabel('关闭预览', { exact: true }).click();
    console.log('PASS', name);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Pick files').setInputFiles([...files, ...files, ...files]);
  await page.getByRole('button', { name: '预览 image.png' }).last().click();
  await expect(page.getByRole('dialog')).toContainText('9 / 9');
  await expect(page.getByRole('dialog').locator('img')).toBeVisible();
  await expect.poll(() => page.getByRole('dialog').locator('img').evaluate(image => image.naturalWidth)).toBe(600);
  await page.screenshot({ path: path.join(artifacts, 'mobile-preview.png') });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(artifacts, 'mobile-rail.png') });

  // Local SVGs are displayed as images, never as active documents. Exercise the
  // File -> object URL -> thumbnail/preview path reported by CodeQL in Chrome.
  const hostileName = '"><img data-injected="true" onerror="window.__attachmentScriptRan=true">.svg';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" onload="window.__attachmentScriptRan=true"><script>window.__attachmentScriptRan=true</script><rect width="32" height="32" fill="red"/></svg>';
  await page.getByLabel('Pick files').setInputFiles([{ name: hostileName, mimeType: 'image/svg+xml', buffer: Buffer.from(svg) }]);
  const thumbnail = page.getByRole('button', { name: '预览 ' + hostileName, exact: true });
  await expect.poll(() => thumbnail.locator('img').evaluate(image => image.naturalWidth)).toBe(32);
  await thumbnail.click();
  await expect.poll(() => page.getByRole('dialog').locator('img').evaluate(image => image.naturalWidth)).toBe(32);
  expect(await page.evaluate(() => Boolean(window.__attachmentScriptRan))).toBe(false);
  await expect(page.locator('[data-injected]')).toHaveCount(0);
  // Opening the old raw SVG blob as a document executed its script with the app
  // origin. Every visible image URL must now contain only newly encoded PNG bytes.
  const previewURLs = [await thumbnail.locator('img').getAttribute('src'), await page.getByRole('dialog').locator('img').getAttribute('src')];
  for (const url of previewURLs) {
    const payload = await page.evaluate(async url => {
      const response = await fetch(url);
      return { type: response.headers.get('Content-Type'), signature: Array.from(new Uint8Array(await response.arrayBuffer()).slice(0, 8)) };
    }, url);
    expect(payload).toEqual({ type: 'image/png', signature: [137, 80, 78, 71, 13, 10, 26, 10] });
    const opened = await page.context().newPage();
    await opened.goto(url);
    expect(await opened.evaluate(() => Boolean(window.__attachmentScriptRan))).toBe(false);
    await opened.close();
  }
  const downloadUrl = await page.getByRole('dialog').getByRole('link').getAttribute('href');
  expect(await page.evaluate(async url => (await fetch(url)).headers.get('Content-Type'), downloadUrl)).toBe('application/octet-stream');
  const downloadPage = await page.context().newPage();
  const downloading = downloadPage.waitForEvent('download');
  await downloadPage.goto(downloadUrl).catch(error => expect(error.message).toMatch(/download|ERR_ABORTED/i));
  const downloaded = await downloading;
  expect(await readFile(await downloaded.path(), 'utf8')).toBe(svg);
  expect(await downloadPage.evaluate(() => Boolean(window.__attachmentScriptRan))).toBe(false);
  await downloadPage.close();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
  console.log('PASS HTML-like filenames and SVG script/event payloads stay inert in thumbnails and previews');
  console.log('PASS image URLs opened as documents contain PNG only; raw downloads retain bytes without executing markup');
  console.log('PASS image navigation, sent grid, document previews, fallback, worksheet switch and mobile rail');
  console.log('Screenshots:', artifacts);
} finally {
  await browser.close();
}
