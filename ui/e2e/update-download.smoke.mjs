// Vite on port 5187. Native transport is tested by verify-update-download.cjs.
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const artifacts = process.env.PILOTDECK_UPDATE_ARTIFACTS || '/tmp/pilotdeck-update-download';
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PILOTDECK_TEST_BROWSER_CHANNEL || 'chrome', headless: true });
try {
  for (const language of ['zh-CN', 'en']) {
    const page = await browser.newPage({ viewport: { width: 1080, height: 760 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/config', route => route.fulfill({ json: {} }));
    await page.goto(`http://127.0.0.1:5187/e2e/fixtures/update-download.html?language=${language}`);
    const pause = language === 'zh-CN' ? '暂停下载' : 'Pause';
    const resume = language === 'zh-CN' ? '继续下载' : 'Resume download';
    const cancel = language === 'zh-CN' ? '取消下载' : 'Cancel download';
    await expect(page.getByRole('button', { name: pause, exact: true })).toBeVisible();
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
    await expect(page.getByText('84.0 MB / 200.0 MB')).toBeVisible();
    await expect(page.locator('.desktop-update-speed')).toContainText('2.4 MB/s');
    for (const theme of [{ name: 'light', preset: 'default' }, { name: 'mist-blue', preset: 'blue' }, { name: 'dark', preset: 'default', dark: true }]) {
      await page.evaluate(theme => window.updateTest.theme(theme.preset, theme.dark), theme);
      for (const width of [1080, 520]) {
        await page.setViewportSize({ width, height: 760 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const buttons = await page.locator('.desktop-update-transfer-actions button').all();
        for (const button of buttons) {
          const bounds = await button.boundingBox();
          expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        }
        await page.screenshot({ path: path.join(artifacts, `${language}-${theme.name}-${width}.png`), animations: 'disabled' });
      }
    }
    await page.getByRole('button', { name: pause, exact: true }).click();
    await expect(page.locator('.desktop-update-transfer')).toHaveAttribute('data-state', 'paused');
    await expect(page.locator('.desktop-update-speed')).toContainText('—');
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
    await page.screenshot({ path: path.join(artifacts, `${language}-paused.png`), animations: 'disabled' });
    await page.getByRole('button', { name: resume, exact: true }).click();
    await expect(page.locator('.desktop-update-transfer')).toHaveAttribute('data-state', 'downloading');
    await page.getByRole('button', { name: cancel, exact: true }).click();
    await expect(page.locator('.desktop-update-transfer')).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.close();
  }
  console.log('Update UI: Chinese/English, 3 themes, 2 widths, progress/size/speed and pause/resume/cancel passed.');
} finally { await browser.close(); }
