// Start Vite on 5187. Exercises the production settings views with isolated API data.
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = path.join(root, 'artifacts/settings-refinement/web');
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PILOTDECK_TEST_BROWSER_CHANNEL || 'chrome' });
const page = await browser.newPage({ viewport: { width: 1320, height: 900 } });
let config = { tools: { webSearch: { enabled: true, provider: 'glm' } }, cron: { enabled: false, timezone: 'Asia/Shanghai', maxConcurrentRuns: 2 } };
let revision = 1;
const errors = [], measurements = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  if (!localStorage.getItem('userLanguage')) localStorage.setItem('userLanguage', 'zh-CN');
  if (!localStorage.getItem('themeMode')) localStorage.setItem('themeMode', 'light');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register = () => Promise.reject(new Error('isolated settings test'));
});
await page.route('**/api/**', async route => {
  const request = route.request(), url = new URL(request.url()).pathname;
  let body = {};
  if (url === '/api/config') {
    if (request.method() === 'PUT') { config = parse(request.postDataJSON().raw); revision++; }
    body = { exists: true, raw: JSON.stringify(config), path: '/fixture/settings.yaml', revision: String(revision), validation: { valid: true, errors: [], warnings: [] } };
  } else if (url.includes('onboarding-status')) body = { hasCompletedOnboarding: true };
  else if (url === '/api/projects') body = [{ name: 'demo', displayName: 'Settings test', fullPath: '/fixture/demo', kind: 'workspace', sessions: [], capabilities: { files: true } }];
  else if (url.includes('sessions')) body = { sessions: [], hasMore: false, total: 0 };
  else if (url.includes('models') || url.includes('providers')) body = { models: [], providers: [] };
  else if (url.includes('skills') || url.includes('plugins')) body = { skills: [], plugins: [] };
  else if (url.includes('cron')) body = { jobs: [] };
  else if (url.includes('tasks')) body = { tasks: [] };
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
});
await page.routeWebSocket('**/ws**', socket => socket.onMessage(() => {}));
async function verifyModeCardAlignment(width) {
  await expect(page.locator('.appearance-mode')).toHaveCount(3);
  await expect(page.locator('.appearance-preset')).toHaveCount(7);
  await expect(page.locator('.appearance-preset').first()).toBeVisible();
  const rectangles = await page.locator('.appearance-mode, .appearance-preset').evaluateAll(elements => elements.map(element => {
    const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
  }));
  const modes = rectangles.slice(0, 3), presets = rectangles.slice(3);
  const reference = presets.filter(rectangle => rectangle.top === presets[0].top).slice(-3);
  expect(reference).toHaveLength(3);
  for (let i = 0; i < modes.length; i++) {
    for (const dimension of ['left', 'right', 'width', 'height']) expect(Math.abs(modes[i][dimension] - reference[i][dimension])).toBeLessThan(.1);
  }
  measurements.push({ viewport: width, modes, alignedPresets: reference });
}
try {
  for (const width of [1320, 1600, 960]) {
    await page.setViewportSize({ width, height: 900 });
    const cards = [];
    for (const [route, selector] of [['general', '.general-card'], ['agent-route', '.route-card'], ['agent-memory', '.memory-enable-card'], ['appearance', '.appearance-card']]) {
      await page.goto('http://127.0.0.1:5187/settings/' + route);
      const card = page.locator(selector).first(); await expect(card).toBeVisible();
      cards.push(await card.evaluate(element => { const r = element.getBoundingClientRect(); return { left: r.left, width: r.width }; }));
    }
    for (const card of cards) expect(card).toEqual(cards[0]);
    measurements.push({ viewport: width, cards });
    await verifyModeCardAlignment(width);
  }
  await page.setViewportSize({ width: 1320, height: 900 });
  await page.goto('http://127.0.0.1:5187/settings/agent-route');
  const routeFont = await page.locator('.route-card-heading h2').first().evaluate(element => getComputedStyle(element).fontSize);
  await page.goto('http://127.0.0.1:5187/settings/agent-memory');
  const memoryFont = await page.locator('.memory-enable-card h2').evaluate(element => getComputedStyle(element).fontSize);
  expect(routeFont).toBe('14px'); expect(memoryFont).toBe(routeFont);
  await page.goto('http://127.0.0.1:5187/settings/appearance');
  await expect(page.locator('#appearance-palette')).toBeVisible();
  await expect(page.locator('#appearance-palette button')).toHaveCount(7);
  const presetRects = await page.locator('#appearance-palette button').evaluateAll(elements => elements.map(element => {
    const r = element.getBoundingClientRect(); return { top: r.top, width: r.width, right: r.right };
  }));
  expect(new Set(presetRects.map(rect => rect.top)).size).toBe(1);
  for (const rect of presetRects) { expect(rect.width).toBeGreaterThan(100); expect(rect.right).toBeLessThan(1320); }
  await page.locator('#appearance-palette [data-preset=blue]').click();
  const systemMode = page.locator('.appearance-mode[data-mode=system]');
  await systemMode.focus(); await systemMode.press('Space');
  await expect(systemMode).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).not.toHaveAttribute('data-light-appearance');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-light-appearance');
  await page.locator('.appearance-mode[data-mode=dark]').click();
  await expect(page.locator('.appearance-mode[data-mode=dark]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.appearance-mode[data-mode=light]').click();
  await page.reload();
  await expect(page.locator('.appearance-mode[data-mode=light]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#appearance-palette [data-preset=blue]')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(350);
  await expect(page.locator('.appearance-live-preview')).toHaveCount(0);
  const geometry = await page.locator('.appearance-color-control,.appearance-segments').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect(); return { left: rect.left, width: rect.width, height: rect.height };
  }));
  expect(geometry).toHaveLength(3);
  for (const control of geometry) expect(control).toEqual(geometry[0]);
  expect(geometry[0].width).toBe(176); expect(geometry[0].height).toBe(36);
  measurements.push({ screen: 'appearance', geometry });
  await page.screenshot({ path: path.join(artifacts, 'appearance.png') });
  await page.locator('#appearance-palette [data-preset=custom]').click();
  const picker = page.getByRole('dialog', { name: '强调色', exact: true });
  await expect(picker).toBeVisible();
  const input = picker.getByRole('textbox');
  await input.fill('xyz'); await input.press('Enter');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await input.fill('123'); await input.press('Enter');
  await expect(page.getByRole('button', { name: '强调色', exact: true })).toContainText('#112233');
  await input.fill('187c65');
  await expect(page.getByRole('button', { name: '强调色', exact: true })).toContainText('#187C65');
  await expect(picker).toBeVisible();
  await expect(picker.locator('.appearance-color-plane')).toHaveCSS('background-color', 'rgb(0, 255, 196)');
  await page.screenshot({ path: path.join(artifacts, 'color-picker.png') });
  await input.press('Escape'); await expect(picker).toHaveCount(0);
  await expect(page.getByRole('button', { name: '强调色', exact: true })).toBeFocused();
  await page.reload(); await expect(page.getByRole('button', { name: '强调色', exact: true })).toContainText('#187C65');

  await page.goto('http://127.0.0.1:5187/settings/agent-search');
  const provider = page.locator('#search-provider');
  await provider.selectOption('bocha');
  const help = page.locator('.search-provider-help');
  await expect(help).toHaveCSS('font-size', routeFont);
  await expect(help).toHaveAttribute('href', 'https://github.com/Bocha-Labs/bocha-skills/tree/main/bocha-web-search');
  await help.hover(); await expect(page.getByRole('tooltip')).toContainText('博查 Web 搜索');
  await page.screenshot({ path: path.join(artifacts, 'search-help.png') });
  await provider.focus(); await help.focus(); await expect(page.getByRole('tooltip')).toBeVisible();
  const alignment = await page.locator('.search-setting-row').first().evaluate(row => {
    const copy = row.querySelector('.search-setting-copy').getBoundingClientRect(), control = row.querySelector('select').getBoundingClientRect();
    return Math.abs(copy.top + copy.height / 2 - control.top - control.height / 2);
  });
  expect(alignment).toBeLessThan(1); measurements.push({ screen: 'search', centerDifference: alignment });
  await provider.selectOption('exa'); await expect(help).toHaveAttribute('href', 'https://exa.ai/docs/reference/search');
  await provider.selectOption('custom'); await expect(help).toHaveCount(0);
  await provider.selectOption('bocha');

  await page.goto('http://127.0.0.1:5187/settings/agent-schedule');
  const scheduling = page.getByRole('switch', { name: '启用定时任务', exact: true });
  await expect(page.locator('.scheduled-enable-card h2')).toHaveCSS('font-size', routeFont);
  await scheduling.click(); await expect.poll(() => config.cron.enabled).toBe(true);
  await scheduling.click(); await expect.poll(() => config.cron.enabled).toBe(false);
  expect(config.cron.timezone).toBe('Asia/Shanghai'); expect(config.cron.maxConcurrentRuns).toBe(2);
  await page.screenshot({ path: path.join(artifacts, 'schedule.png') });

  await page.goto('http://127.0.0.1:5187/');
  const sidebar = page.locator('.project-sidebar'), resizer = page.locator('.project-sidebar + .sidebar-resizer');
  await expect(resizer).toBeVisible();
  for (const width of [300, 180, 340]) {
    const box = await resizer.boundingBox(), initial = await sidebar.evaluate(element => element.getBoundingClientRect().width);
    await page.mouse.move(box.x + 2, 220); await page.mouse.down();
    await page.mouse.move(box.x + 2 + width - initial, 220, { steps: 12 }); await page.mouse.up();
    await expect.poll(() => sidebar.evaluate(element => element.getBoundingClientRect().width)).toBe(width);
  }
  // Native mouse events catch a drag overlay swallowing the double-click.
  await resizer.dblclick({ position: { x: .5, y: 120 }, delay: 100 });
  await expect.poll(() => sidebar.evaluate(element => element.getBoundingClientRect().width)).toBe(220);
  expect(await page.evaluate(() => localStorage.getItem('sidebar-v2-width'))).toBe('220');

  for (const width of [960, 736, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ['appearance', 'agent-search', 'agent-schedule']) {
      await page.goto('http://127.0.0.1:5187/settings/' + route);
      await expect(page.locator('.page-header')).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      if (route === 'appearance') await verifyModeCardAlignment(width);
      if (route === 'agent-search') {
        await help.focus(); const tip = page.getByRole('tooltip'); await expect(tip).toBeVisible();
        await expect.poll(() => tip.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; })).toBe(true);
      }
      await page.screenshot({ path: path.join(artifacts, `${width}-${route}.png`) });
    }
  }
  await page.setViewportSize({ width: 1320, height: 900 });
  await page.goto('http://127.0.0.1:5187/settings/appearance');
  await page.evaluate(() => localStorage.setItem('userLanguage', 'en')); await page.reload();
  await expect(page.locator('#appearance-palette')).toHaveAccessibleName('Color palette');
  await page.screenshot({ path: path.join(artifacts, 'appearance-en.png') });
  expect(errors).toEqual([]);
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ passed: true, measurements, errors }, null, 2));
  console.log('PASS: compact alignment, picker persistence/keyboard/HEX, provider help hover/focus/targets, scheduling switches, sidebar drag/reset, narrow windows and English');
} finally { await browser.close(); }
