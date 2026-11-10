// Vite on 5187. Synthetic histories and isolated browser storage only.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const baseUrl = process.env.PILOTDECK_SMOKE_URL || 'http://127.0.0.1:5187';
const output = process.env.PILOTDECK_SMOKE_OUTPUT || resolve('artifacts/usage');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PILOTDECK_TEST_BROWSER_CHANNEL || 'chrome', headless: true });
const baseDays = [
  { date: '2024-02-29', tokens: 100_000, callCount: 4 },
  ...Array.from({ length: 280 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), tokens: i % 9 < 2 ? 0 : Math.round((i + 3) * (i % 7 + 1) * 110), callCount: i % 9 < 2 ? 0 : i % 8 + 1 })),
  { date: '2026-10-08', tokens: 12_000, callCount: 2 },
  { date: '2026-10-09', tokens: 18_000, callCount: 2 },
  { date: '2026-10-10', tokens: 25_000, callCount: 2 },
  { date: '2026-10-11', tokens: 30_000, callCount: 2 },
  { date: '2026-10-12', tokens: 65_600, callCount: 4 },
];
let usage = { timeZone: 'Asia/Shanghai', today: '2026-10-12', updatedAt: '2026-10-12T08:00:00Z', days: baseDays,
  totalTokens: baseDays.reduce((sum, day) => sum + day.tokens, 0), totalCalls: baseDays.reduce((sum, day) => sum + day.callCount, 0) };
let fail = false;
const report = [];
async function fixture(context) {
  await context.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body = {}, status = 200;
    if (path === '/api/usage') { expect(route.request().method()).toBe('GET'); body = usage; status = fail ? 500 : 200; }
    else if (path === '/api/auth/status') body = { authDisabled: true };
    else if (path === '/api/settings/general-workspace') body = { directory: '', effectiveDirectory: '/fixture/general', defaultDirectory: '/fixture/general' };
    else if (path === '/api/config') body = { exists: true, path: '/fixture/config.yaml', raw: 'agent:\n  model: test/model\n', revision: '1', validation: { valid: true, errors: [], warnings: [] } };
    else if (path === '/api/projects') body = [];
    else if (path.includes('onboarding-status')) body = { hasCompletedOnboarding: true };
    else if (path.includes('providers') || path.includes('models')) body = { providers: [], models: [] };
    else if (path.includes('sessions')) body = { sessions: [], hasMore: false, total: 0 };
    else if (path.includes('tasks')) body = { tasks: [] };
    else if (path.includes('skills') || path.includes('plugins')) body = { skills: [], plugins: [] };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await context.routeWebSocket('**/ws**', socket => socket.onMessage(() => {}));
}
async function ready(page) {
  await expect(page.locator('.pd-startup-screen')).toHaveCount(0, { timeout: 60000 });
  await expect(page.locator('.usage-stat-total strong')).toHaveAttribute('title', new Intl.NumberFormat('en').format(usage.totalTokens));
}
async function screenshot(page, name) { await page.screenshot({ path: join(output, name + '.png'), fullPage: true }); }
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    if (!localStorage.getItem('userLanguage')) localStorage.setItem('userLanguage', 'zh-CN');
    if (!localStorage.getItem('themeMode')) localStorage.setItem('themeMode', 'light');
  });
  await fixture(context);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${baseUrl}/settings/usage`); await ready(page);
  const expectCenteredBody = async () => {
    const bounds = await page.locator('.usage-content').evaluate(node => {
      const content = node.getBoundingClientRect(), body = node.querySelector('.usage-body').getBoundingClientRect();
      const title = node.querySelector('h1').getBoundingClientRect();
      const chart = node.querySelector('.usage-heatmap-layout').getBoundingClientRect();
      const scroll = node.querySelector('.usage-heatmap-scroll').getBoundingClientRect();
      return { content: content.left + content.width / 2, body: body.left + body.width / 2,
        title: title.left, left: content.left, chart: chart.left + chart.width / 2,
        scroll: scroll.left + scroll.width / 2, fits: chart.width <= scroll.width };
    });
    expect(Math.abs(bounds.body - bounds.content)).toBeLessThan(1);
    expect(bounds.title).toBeCloseTo(bounds.left + 2, 0);
    if (bounds.fits) expect(Math.abs(bounds.chart - bounds.scroll)).toBeLessThan(1);
  };
  await expectCenteredBody();
  const headingStyle = element => {
    const style = getComputedStyle(element);
    return Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing'].map(key => [key, style[key]]));
  };
  const usageHeading = await page.locator('.usage-header h1').evaluate(headingStyle);
  await page.goto(`${baseUrl}/settings/general`);
  await expect(page.locator('.pd-startup-screen')).toHaveCount(0, { timeout: 60000 });
  await expect(page.locator('.page-header h1')).toBeVisible();
  expect(await page.locator('.page-header h1').evaluate(headingStyle)).toEqual(usageHeading);
  await page.goto(`${baseUrl}/settings/usage`); await ready(page);
  await expect(page.locator('.usage-heatmap button')).toHaveCount(365);
  await expect(page.locator('.usage-heatmap button[tabindex="0"]')).toHaveCount(1);
  await expect(page.locator('.usage-stat-today strong')).toHaveAttribute('title', '65,600');
  await expect(page.locator('.usage-day-detail, .usage-footnote, .usage-empty-note')).toHaveCount(0);
  await expect(page.locator('.usage-activity')).toHaveCSS('border-top-width', '0px');
  await expect(page.locator('.usage-refresh')).toHaveCSS('border-top-width', '0px');
  await screenshot(page, 'usage-zh-light-daily');
  await page.locator('[data-date="2026-10-11"]').click();
  await expect(page.locator('.usage-day-detail')).toContainText('30,000');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-date="2026-10-12"]')).toBeFocused();
  await expect(page.locator('.usage-day-detail')).toContainText('65,600');
  await page.getByRole('tab', { name: '每周', exact: true }).click();
  expect(await page.locator('.usage-weekly button').count()).toBeGreaterThanOrEqual(52);
  await page.locator('.usage-weekly button').last().click();
  await expect(page.locator('.usage-day-detail')).toContainText('65,600');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.usage-day-detail')).toContainText('2026年10月5日');
  await screenshot(page, 'usage-zh-light-weekly');
  await page.getByRole('tab', { name: '每周', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '累计总量', exact: true })).toBeFocused();
  await page.locator('.usage-cumulative button[tabindex="0"]').focus(); await page.keyboard.press('End');
  await expect(page.locator('.usage-day-detail strong')).toContainText(new Intl.NumberFormat('en').format(usage.totalTokens));
  await page.keyboard.press('Home');
  await expect(page.locator('.usage-day-detail strong')).toContainText('100,000'); // older than visible year
  await screenshot(page, 'usage-zh-light-cumulative');
  await page.getByLabel('统计时间范围').selectOption('2024');
  await page.locator('.usage-cumulative button[tabindex="0"]').focus(); await page.keyboard.press('End');
  await page.getByRole('tab', { name: '每天', exact: true }).click();
  await expect(page.locator('.usage-heatmap button')).toHaveCount(366);
  await page.getByRole('tab', { name: '累计总量', exact: true }).click();
  await page.locator('.usage-cumulative button[tabindex="0"]').focus();
  await expect(page.locator('.usage-day-detail strong')).toContainText('100,000');
  await expect(page.locator('.usage-stat-total strong')).toHaveAttribute('title', new Intl.NumberFormat('en').format(usage.totalTokens));
  await page.reload(); await ready(page);
  await expect(page.getByRole('tab', { name: '累计总量', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.locator('.usage-cumulative button[tabindex="0"]').focus(); await page.keyboard.press('End');
  await expect(page.locator('.usage-day-detail strong')).toContainText(new Intl.NumberFormat('en').format(usage.totalTokens));
  fail = true; await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.locator('.usage-content [role="alert"]')).toBeVisible();
  await expect(page.locator('.usage-stat-today strong')).toHaveAttribute('title', '65,600');
  fail = false;
  usage = { ...usage, totalTokens: usage.totalTokens + 400, days: usage.days.map(day => day.date === usage.today ? { ...day, tokens: 66_000 } : day) };
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.locator('.usage-content [role="alert"]')).toHaveCount(0);
  for (const dismiss of await page.getByRole('button', { name: 'Dismiss', exact: true }).all()) await dismiss.click();
  await expect(page.locator('.usage-stat-today strong')).toHaveAttribute('title', '66,000');
  await page.getByRole('tab', { name: '每天', exact: true }).click();
  for (const width of [1920, 1440, 858, 390]) {
    await page.setViewportSize({ width, height: 1039 });
    await page.getByRole('tab', { name: '每天', exact: true }).click();
    const cell = await page.locator('.usage-heatmap button').last().boundingBox();
    const legend = await page.locator('.usage-legend .usage-cell').first().boundingBox();
    expect(cell.width).toBe(10); expect(cell.height).toBe(10); expect(cell.width).toBe(legend.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const label of ['每天', '每周', '累计总量']) {
      await page.getByRole('tab', { name: label, exact: true }).click();
      await expectCenteredBody();
      for (const box of await page.locator('#usage-activity-panel .usage-cell').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })))) {
        expect(box).toEqual({ width: 10, height: 10 });
      }
      await screenshot(page, `usage-${width}-${label}`);
    }
  }
  expect(errors).toEqual([]);
  await context.close();
  // Actual locale/theme boot paths: all twelve paired palettes in both languages.
  for (const language of ['zh-CN', 'en']) for (const mode of ['light', 'dark']) for (const preset of ['default', 'blue', 'mint', 'apricot', 'rose', 'gray']) {
    const context = await browser.newContext({ viewport: { width: 1129, height: 1039 } });
    await context.addInitScript(({ language, mode, preset }) => {
      localStorage.setItem('userLanguage', language); localStorage.setItem('themeMode', mode);
      localStorage.setItem('pilotdeck-light-appearance-v1', JSON.stringify({ preset }));
    }, { language, mode, preset });
    await fixture(context);
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${baseUrl}/settings/usage`); await ready(page);
    await expect(page.getByRole('tab', { name: language === 'en' ? 'Daily' : '每天', exact: true })).toBeVisible();
    expect(await page.locator('.usage-content').innerText()).not.toMatch(/usage\.[A-Za-z]/);
    if (language === 'en') expect(await page.locator('.usage-content').innerText()).not.toMatch(/[\u4e00-\u9fff]/);
    expect(await page.locator('.usage-heatmap button').first().getAttribute('aria-label')).not.toMatch(/usage\./);
    const ink = await page.locator('.usage-stat-label').first().evaluate(el => {
      const style = getComputedStyle(el), background = getComputedStyle(el.closest('.usage-summary')).backgroundColor;
      const lum = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;}).reduce((a, v, i) => a + v * [.2126, .7152, .0722][i], 0);
      return (Math.max(lum(style.color), lum(background)) + .05) / (Math.min(lum(style.color), lum(background)) + .05);
    });
    expect(ink).toBeGreaterThanOrEqual(4.5);
    const accent = await page.evaluate(() => { const el = document.createElement('span'); el.style.backgroundColor = 'var(--brand)'; document.querySelector('.usage-content').append(el); const color = getComputedStyle(el).backgroundColor; el.remove(); return color; });
    await expect(page.locator('.usage-legend .usage-level-4')).toHaveCSS('background-color', accent);
    await screenshot(page, `${language}-${mode}-${preset}`);
    expect(errors).toEqual([]); report.push({ language, mode, preset, accent, contrast: ink });
    await context.close();
  }
  // Empty states must not invent activity or fill any weekly/cumulative cells.
  usage = { ...usage, today: '2026-01-01', days: [], totalTokens: 0, totalCalls: 0 };
  const empty = await browser.newContext({ viewport: { width: 1129, height: 900 } }); await fixture(empty);
  const pageEmpty = await empty.newPage(); await pageEmpty.goto(`${baseUrl}/settings/usage`); await ready(pageEmpty);
  await pageEmpty.getByRole('combobox', { name: 'Activity period' }).selectOption('2026');
  await expect(pageEmpty.locator('.usage-heatmap button')).toHaveCount(1);
  await pageEmpty.getByRole('tab', { name: 'Cumulative', exact: true }).click();
  await expect(pageEmpty.locator('.usage-cumulative button')).toHaveCount(1);
  await expect(pageEmpty.locator('.usage-cumulative .usage-level-4')).toHaveCount(0);
  await screenshot(pageEmpty, 'usage-empty');
  usage = { ...usage, totalTokens: 1, totalCalls: 1, days: [{ date: usage.today, tokens: 1, callCount: 1 }] };
  await pageEmpty.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(pageEmpty.locator('.usage-stat-active')).toContainText('1day');
  await pageEmpty.getByRole('tab', { name: 'Weekly', exact: true }).click();
  await expect(pageEmpty.locator('.usage-weekly button')).toHaveAttribute('aria-label', /1 call$/);
  await pageEmpty.locator('.usage-weekly button').click();
  await expect(pageEmpty.locator('.usage-day-detail')).toContainText('1 call');
  await empty.close();
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log('PASS: all three fixed-cell views, keyboard, leap year/history, cumulative baseline, reload, failed refresh recovery, 1920/1440/858/390px cells, 24 locale/palette combinations and empty state');
} finally { await browser.close(); }
