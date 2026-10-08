// Uses the real About component and translations with a simulated desktop bridge.
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const artifacts = process.env.PILOTDECK_UPDATE_ARTIFACTS || '/tmp/pilotdeck-update-actions';
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PILOTDECK_TEST_BROWSER_CHANNEL || 'chrome', headless: true });
try {
  for (const language of ['zh-CN', 'en']) {
    const check = language === 'zh-CN' ? '重新检查' : 'Check again';
    const install = language === 'zh-CN' ? '更新并重启' : 'Update and restart';
    for (const state of ['upToDate', 'unavailable', 'failed', 'available']) {
      const page = await browser.newPage({ viewport: { width: 1080, height: 600 } });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/config', route => route.fulfill({ json: {} }));
      await page.goto(`http://127.0.0.1:5187/e2e/fixtures/update-download.html?language=${language}&state=${state}&platform=darwin`);
      const initialButton = page.getByRole('button', { name: state === 'available' ? install : check, exact: true });
      await expect(initialButton).toBeEnabled();
      await expect(page.getByText('Electron', { exact: true })).toHaveCount(0);
      await expect(page.locator('[data-settings-surface=panel]')).toHaveCount(1);
      for (const theme of [{ name: 'blue', preset: 'blue', width: 1080 }, { name: 'dark', dark: true, width: 520 }]) {
        await page.evaluate(theme => window.updateTest.theme(theme.preset, theme.dark), theme);
        await page.setViewportSize({ width: theme.width, height: 600 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await page.locator('main').innerText()).not.toMatch(/settingsPage\.|pilotDeckConfig\./);
        await page.screenshot({ path: path.join(artifacts, `${language}-${state}-${theme.name}.png`), animations: 'disabled' });
      }
      if (state !== 'available') {
        if (state === 'unavailable') {
          await page.evaluate(() => window.updateTest.release({ checkUnavailable: true, hasUpdate: false, canDownload: false, reason: 'checkFailed', latest: null }));
          await initialButton.click(); await expect(initialButton).toBeEnabled();
          expect(await page.evaluate(() => window.updateTest.calls)).toEqual(['check']);
          await page.evaluate(() => window.updateTest.release({}));
        }
        await initialButton.click();
        await expect(page.getByRole('button', { name: install, exact: true })).toBeEnabled();
        expect(await page.evaluate(() => window.updateTest.calls.every(action => action === 'check'))).toBe(true);
      }
      await page.getByRole('button', { name: install, exact: true }).click();
      await expect(page.getByRole('progressbar')).toBeVisible();
      expect(await page.evaluate(() => window.updateTest.calls.filter(action => action === 'start').length)).toBe(1);
      expect(errors).toEqual([]); await page.close();
    }
    for (const platform of ['win32', 'linux']) {
      const page = await browser.newPage();
      await page.route('**/api/config', route => route.fulfill({ json: {} }));
      await page.goto(`http://127.0.0.1:5187/e2e/fixtures/update-download.html?language=${language}&state=upToDate&platform=${platform}`);
      await expect(page.getByRole('button', { name: check, exact: true })).toBeEnabled();
      await page.getByRole('button', { name: check, exact: true }).click();
      await expect(page.getByRole('button', { name: install, exact: true })).toBeEnabled();
      await page.close();
    }
  }
  console.log('About update actions passed: both languages, macOS card removal, no update/check failure/download failure/available, repeated checks, 2 themes/widths and Windows/Linux UI.');
} finally { await browser.close(); }
