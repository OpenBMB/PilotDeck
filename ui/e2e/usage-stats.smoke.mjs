import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const baseUrl = process.env.PILOTDECK_SMOKE_URL || 'http://127.0.0.1:5187';
const output = process.env.PILOTDECK_SMOKE_OUTPUT || join(tmpdir(), 'pilotdeck-usage-smoke');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('userLanguage', 'zh-CN');
    if (!localStorage.getItem('themeMode')) localStorage.setItem('themeMode', 'light');
  });
  let usage = {
    timeZone: 'Asia/Shanghai', today: '2026-10-12', updatedAt: '2026-10-12T08:00:00Z', totalTokens: 150_600, totalCalls: 12,
    days: [
      { date: '2026-10-08', tokens: 12_000, callCount: 2 },
      { date: '2026-10-09', tokens: 18_000, callCount: 2 },
      { date: '2026-10-10', tokens: 25_000, callCount: 2 },
      { date: '2026-10-11', tokens: 30_000, callCount: 2 },
      { date: '2026-10-12', tokens: 65_600, callCount: 4 },
    ],
  };
  let fail = false;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    let status = 200;
    if (path === '/api/usage') { body = usage; status = fail ? 500 : 200; }
    else if (path === '/api/config') body = { exists: true, path: '/fixture/config.yaml', raw: 'agent:\n  model: test/model\n', revision: '1', validation: { valid: true, errors: [], warnings: [] } };
    else if (path === '/api/projects') body = [];
    else if (path.includes('onboarding-status')) body = { hasCompletedOnboarding: true };
    else if (path.includes('providers') || path.includes('models')) body = { providers: [], models: [] };
    else if (path.includes('sessions')) body = { sessions: [], hasMore: false, total: 0 };
    else if (path.includes('tasks')) body = { tasks: [] };
    else if (path.includes('skills') || path.includes('plugins')) body = { skills: [], plugins: [] };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.routeWebSocket('**/ws**', socket => socket.onMessage(() => {}));
  await page.goto(`${baseUrl}/settings/usage`);
  await expect(page.locator('.usage-stat-today strong')).toHaveAttribute('title', '65,600');
  await expect(page.locator('.usage-heatmap button')).toHaveCount(365);
  await expect(page.locator('.usage-heatmap button[aria-label^="2026-10-12"]')).toHaveClass(/usage-level-1/);
  await expect(page.locator('.usage-legend .usage-level-4')).toHaveAttribute('title', '3亿 Token 及以上');
  await expect(page.locator('.usage-day-detail')).toHaveCount(0);
  const menu = (await page.locator('.settings-sidebar .nav-item').allTextContents()).map(text => text.trim());
  expect(menu.indexOf('用量统计')).toBe(menu.indexOf('模型池') + 1);
  await page.screenshot({ path: join(output, 'usage-light.png'), fullPage: true });
  await page.getByRole('button', { name: /2026-10-11 ·/ }).click();
  await expect(page.locator('.usage-day-detail')).toContainText('30,000');
  fail = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.locator('.usage-content [role="alert"]')).toBeVisible();
  await expect(page.locator('.usage-stat-today strong')).toHaveAttribute('title', '65,600');
  fail = false;
  usage = { ...usage, totalTokens: 151_000, days: usage.days.map(day => day.date === usage.today ? { ...day, tokens: 66_000 } : day) };
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.locator('.usage-content [role="alert"]')).toHaveCount(0);
  await expect(page.locator('.usage-stat-today strong')).toHaveAttribute('title', '66,000');
  await page.evaluate(() => { localStorage.setItem('themeMode', 'dark'); localStorage.setItem('theme', 'dark'); });
  await page.reload();
  await expect(page.locator('.usage-stat-today strong')).toHaveAttribute('title', '66,000');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({ path: join(output, 'usage-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const summary = await page.locator('.usage-summary').boundingBox();
  expect(summary.x + summary.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: join(output, 'usage-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  usage = { ...usage, days: [], totalTokens: 0, totalCalls: 0 };
  await page.evaluate(() => { localStorage.setItem('themeMode', 'light'); localStorage.setItem('theme', 'light'); });
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.reload();
  await expect(page.locator('.usage-stat-today strong')).toHaveAttribute('title', '0');
  await expect(page.locator('.usage-empty-note, .usage-footnote, .usage-header p')).toHaveCount(0);
  await expect(page.locator('.usage-day-detail')).toHaveCount(0);
  const plot = await page.locator('.usage-heatmap').boundingBox();
  const content = await page.locator('.usage-content').boundingBox();
  expect(content.width).toBeLessThanOrEqual(760);
  const stats = await page.locator('.usage-summary').boundingBox();
  expect(stats.height).toBeLessThanOrEqual(90);
  expect(plot.width / content.width).toBeGreaterThan(0.95);
  await page.screenshot({ path: join(output, 'usage-wide-empty.png'), fullPage: true });
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, output, checked: ['navigation', '365 days', 'day selection', 'error recovery', 'refresh', 'light', 'dark', 'mobile', 'wide empty state', 'heatmap fills width'] }));
} finally { await browser.close(); }
