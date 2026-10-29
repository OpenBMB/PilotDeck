// Start Vite on 127.0.0.1:5175, then run this script. Uses the real desktop
// caption installer with synthetic IPC; no account, runtime or native window.
import { chromium, expect } from '@playwright/test';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const captionModule = '/@fs/' + fileURLToPath(new URL('../../apps/desktop/src/preloadChrome.ts', import.meta.url)).replaceAll('\\', '/');
const browser = await chromium.launch({ headless: true, channel: process.env.PILOTDECK_TEST_BROWSER_CHANNEL || 'chrome' });
const tall = await sharp({ create: { width: 400, height: 2400, channels: 3, background: '#526dd8' } }).png().toBuffer();
const wide = await sharp({ create: { width: 2400, height: 400, channels: 3, background: '#e25555' } }).png().toBuffer();
const files = [tall, wide].map((buffer, index) => ({ name: `image-${index}.png`, mimeType: 'image/png', buffer }));
try {
  for (const platform of ['web', 'win32', 'darwin', 'linux']) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('userLanguage', 'zh-CN'));
    await page.goto('http://127.0.0.1:5175/e2e/fixtures/attachment-preview.html');
    if (platform !== 'web') await page.evaluate(async ({ platform, captionModule }) => {
      const { installWindowChrome } = await import(captionModule);
      const ipc = {
        on(channel, listener) {
          if (channel === 'pilotdeck:window-state') window.addEventListener('preview-test-window-state', event => listener({}, event.detail));
          return ipc;
        },
        invoke: async () => [],
        sendSync: channel => channel === 'pilotdeck:get-appearance' ? { language: 'zh-CN' } : { fullscreen: false, dark: false },
      };
      installWindowChrome(platform, ipc);
    }, { platform, captionModule });
    const captionHeight = () => page.evaluate(() => document.getElementById('pilotdeck-window-caption')?.getBoundingClientRect().height || 0);
    const setFullscreen = fullscreen => page.evaluate(fullscreen => {
      window.dispatchEvent(new CustomEvent('preview-test-window-state', { detail: { fullscreen, dark: false } }));
    }, fullscreen);
    const check = async (closeLabel, inset) => {
      const overlay = page.locator('[data-modal-overlay]');
      await expect.poll(async () => Math.round((await overlay.boundingBox()).y)).toBe(Math.round(inset));
      const close = page.getByRole('dialog').getByRole('button', { name: '关闭预览', exact: true });
      if (closeLabel) {
        const bounds = await close.boundingBox();
        expect(bounds.y).toBeGreaterThanOrEqual(inset + 8);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize().height);
        expect(await close.evaluate(button => {
          const box = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        })).toBe(true);
      } else await expect(close).toHaveCount(0);
      await expect.poll(() => page.getByRole('dialog').locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
      const image = await page.getByRole('dialog').locator('img').boundingBox();
      expect(image.y).toBeGreaterThanOrEqual(inset);
      expect(image.y + image.height).toBeLessThanOrEqual(page.viewportSize().height);
      expect(image.x).toBeGreaterThanOrEqual(0);
      expect(image.x + image.width).toBeLessThanOrEqual(page.viewportSize().width);
      expect(await page.locator('[data-modal-overlay]').evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('no-drag');
    };
    for (const viewport of [{ width: 1280, height: 900 }, { width: 640, height: 360 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const inset = await captionHeight();
      await page.getByLabel('Pick files').setInputFiles(files);
      await page.getByRole('button', { name: '预览 image-0.png', exact: true }).click();
      await check('关闭预览', inset);
      if (platform !== 'web') {
        await setFullscreen(true);
        await check('关闭预览', 0);
        await setFullscreen(false);
        await check('关闭预览', inset);
      }
      await page.getByRole('button', { name: '关闭预览', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByText('Send test message', { exact: true }).click();
      await page.getByRole('button', { name: 'Preview image-0.png', exact: true }).click();
      await check(null, inset);
      await page.getByRole('dialog').locator('img').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('button', { name: '下一张图片', exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText('2 / 2');
      await check(null, inset);
      if (platform !== 'web') {
        await setFullscreen(true);
        await check(null, 0);
        await setFullscreen(false);
        await check(null, inset);
      }
      await page.locator('[data-modal-overlay]').click({ position: { x: 8, y: 8 } });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'Preview image-0.png', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      console.log(`PASS ${platform} ${viewport.width}x${viewport.height}: draft/sent controls, image bounds and fullscreen transitions`);
    }
    expect(errors).toEqual([]);
    await page.close();
  }
} finally { await browser.close(); }
