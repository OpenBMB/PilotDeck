// Start Vite on 5187, then run: node ui/e2e/dialog-appearance.smoke.mjs
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const artifacts = process.env.PILOTDECK_DIALOG_ARTIFACTS || '/tmp/pilotdeck-dialog-appearance';
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PILOTDECK_TEST_BROWSER_CHANNEL || 'chrome', headless: true });
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5187/e2e/fixtures/dialog-appearance.html');
  await expect(page.getByRole('button', { name: 'Open images', exact: true })).toBeVisible();
  const presets = await page.evaluate(() => window.dialogAppearancePresets);
  const cases = [
    ...presets.map(preset => ({ name: preset, value: { preset } })),
    { name: 'custom-solid', value: { preset: 'custom', custom: { accent: '#7955b3', background: '#b9dfce' }, background: { type: 'solid' } } },
    { name: 'custom-bright', value: { preset: 'custom', custom: { accent: '#ffff00', background: '#ffffff' } } },
    { name: 'wallpaper', value: { preset: 'blue', background: { type: 'image', imageId: '12345678-1234-1234-1234-123456789012.png' }, transparency: 40 } },
    { name: 'dark', value: { preset: 'blue' }, dark: true },
  ];
  for (const theme of cases) {
    await page.evaluate(({ value, dark }) => window.setDialogAppearance(value, dark), theme);
    await page.getByRole('button', { name: 'Open images', exact: true }).click();
    const preview = page.getByRole('dialog');
    await expect(preview).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.85)');
    await expect(preview.getByRole('button', { name: 'Close preview' })).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(preview.locator('figcaption')).toHaveCSS('color', 'rgba(255, 255, 255, 0.8)');
    await expect(preview.locator('figcaption')).toContainText('1 / 2');
    await preview.getByRole('button', { name: 'Next image' }).click();
    await expect(preview.locator('img')).toHaveAttribute('alt', 'Preview 2');
    await preview.getByRole('button', { name: 'Previous image' }).click();
    await expect(preview.locator('img')).toHaveAttribute('alt', 'Preview 1');
    await page.keyboard.press('ArrowLeft');
    await expect(preview.locator('figcaption')).toContainText('2 / 2');
    await page.keyboard.press('ArrowRight');
    await expect(preview.locator('figcaption')).toContainText('1 / 2');
    await preview.locator('img').click();
    await expect(preview).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
    if (theme.name === 'blue') await page.screenshot({ path: path.join(artifacts, 'mist-blue-preview.png') });
    await page.keyboard.press('Escape');
    await expect(preview).toHaveCount(0);
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');

    await page.getByRole('button', { name: 'Open confirmation', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Appearance confirmation' });
    await expect(panel).toBeVisible();
    await expect(panel.locator('..')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.5)');
    const themed = await panel.evaluate(element => {
      const root = document.documentElement;
      const probe = document.createElement('div');
      probe.style.backgroundColor = root.hasAttribute('data-light-appearance') ? 'var(--pd-surface)' : 'hsl(var(--card))';
      probe.style.borderColor = root.hasAttribute('data-light-appearance') ? 'var(--pd-border)' : 'hsl(var(--border))';
      document.body.append(probe);
      const actual = getComputedStyle(element), expected = getComputedStyle(probe);
      const result = { actual: [actual.backgroundColor, actual.borderTopColor], expected: [expected.backgroundColor, expected.borderTopColor] };
      probe.remove();
      return result;
    });
    expect(themed.actual).toEqual(themed.expected);
    const action = panel.getByRole('button', { name: 'Proceed', exact: true });
    const expectedActionColors = await page.evaluate(() => {
      const probe = document.createElement('div');
      document.body.append(probe);
      probe.style.backgroundColor = 'var(--pd-accent, #5b5ce2)';
      const normal = getComputedStyle(probe).backgroundColor;
      probe.style.backgroundColor = 'var(--pd-accent-strong, #4948cf)';
      const hover = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { normal, hover };
    });
    const actionContrast = () => action.evaluate(element => {
      const style = getComputedStyle(element);
      const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
        const c = v / 255;
        return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
      }).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
      const foreground = luminance(style.color), background = luminance(style.backgroundColor);
      return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    });
    await expect.poll(actionContrast, { message: `${theme.name} confirmation text contrast` }).toBeGreaterThanOrEqual(4.5);
    await expect(action).toHaveCSS('background-color', expectedActionColors.normal);
    await action.hover();
    await expect.poll(actionContrast, { message: `${theme.name} hovered confirmation text contrast` }).toBeGreaterThanOrEqual(4.5);
    await expect(action).toHaveCSS('background-color', expectedActionColors.hover);
    await action.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(action).toBeFocused();
    await expect.poll(() => action.evaluate(element => getComputedStyle(element).boxShadow)).toContain(expectedActionColors.normal);
    if (theme.name === 'blue') await page.screenshot({ path: path.join(artifacts, 'mist-blue-confirmation.png') });
    await action.click();
    await expect(panel).toHaveCount(0);
    results.push({ theme: theme.name, preview: 'dark backdrop; buttons, keys, captions and scroll restored', confirmation: 'themed panel; dim backdrop; action works; normal and hover text contrast >= 4.5' });
  }
  await expect(page.getByRole('status', { name: 'Confirmed count' })).toHaveText(String(cases.length));
  await page.getByRole('button', { name: 'Open single image' }).click();
  await expect(page.getByRole('button', { name: 'Next image' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Previous image' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close preview' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open images', exact: true }).click();
  await page.getByRole('dialog').click({ position: { x: 10, y: 10 } });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
  await fs.writeFile(path.join(artifacts, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`${results.length} theme cases passed; single-image and backdrop-close interactions passed.`);
} finally {
  await browser.close();
}
