// Run a production preview with PILOTDECK_TEST_URL, or use Vite on port 5187.
// This uses synthetic API responses and never contacts a model or user profile.
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseUrl = process.env.PILOTDECK_TEST_URL || 'http://127.0.0.1:5187';
const artifacts = path.join(root, 'artifacts/context-workspace');
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PILOTDECK_TEST_BROWSER_CHANNEL || 'chrome', headless: true });
const results = [];
try {
  for (const [language, theme, width] of [['en', 'light', 1280], ['zh-CN', 'dark', 1280], ['en', 'dark', 360], ['zh-CN', 'light', 360]]) {
    console.log(`Checking ${language} ${theme} ${width}`);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(({ language, theme }) => {
      localStorage.setItem('userLanguage', language); localStorage.setItem('themeMode', theme); localStorage.setItem('theme', theme);
      if ('serviceWorker' in navigator) navigator.serviceWorker.register = () => Promise.reject(new Error('Disabled in fixture'));
    }, { language, theme });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let directory = '';
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()); const p = url.pathname;
      let status = 200, body = {};
      if (p === '/api/auth/status') body = { authDisabled: true };
      else if (p === '/api/projects') body = [
        { name: 'general', displayName: 'general', fullPath: '/fixture/profile', kind: 'general', workspaceCwd: '/fixture/PilotDeckGeneral', sessions: [] },
        { name: 'demo', displayName: 'Demo', fullPath: '/fixture/demo', sessions: [{ id: 'review', title: 'Context review', createdAt: new Date().toISOString() }] },
      ];
      else if (p === '/api/settings/general-workspace') {
        if (route.request().method() === 'PUT') {
          const requested = route.request().postDataJSON().directory;
          if (requested === '/occupied') { status = 400; body = { code: 'GENERAL_WORKSPACE_NOT_EMPTY' }; }
          else directory = requested;
        }
        if (status === 200) body = { directory, effectiveDirectory: directory || '/fixture/PilotDeckGeneral', defaultDirectory: '/fixture/PilotDeckGeneral' };
      }
      else if (p.includes('onboarding-status')) body = { hasCompletedOnboarding: true };
      else if (p.includes('/token-usage')) body = { used: 117000, total: 262144, effectiveTotal: 262144, state: 'ok' };
      else if (p.includes('/messages')) body = { messages: [], hasMore: false, total: 0,
        tokenUsage: { used: 117000, total: 262144, effectiveTotal: 262144, state: 'ok' },
        contextBreakdown: { systemTokens: 2200, toolsTokens: 10200, messageTokens: 65500 } };
      else if (p.includes('/sessions')) body = { sessions: [], hasMore: false, total: 0 };
      else if (p.includes('/files')) body = [];
      else if (p === '/api/config') body = { exists: true, path: '/fixture/config.yaml', raw: JSON.stringify({ model: { providers: {} }, memory: { enabled: false } }), validation: { valid: true, errors: [], warnings: [] } };
      else if (p.includes('/permissions')) body = { success: true, permissions: { skipPermissions: false, allowedTools: [], askTools: [], disallowedTools: [] } };
      else if (p.includes('/skills')) body = { skills: [] };
      else if (p.includes('/plugins')) body = { plugins: [] };
      else if (p.includes('models')) body = { models: [] };
      else if (p.includes('/cron')) body = { jobs: [] };
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.routeWebSocket('**/ws**', socket => socket.onMessage(message => {
      try { if (JSON.parse(String(message)).type === 'ping') socket.send(JSON.stringify({ type: 'pong' })); } catch {}
    }));
    await page.goto(`${baseUrl}/p/demo/c/review`);
    const trigger = page.locator('.pd-composer-context-control > button');
    await expect(trigger).toBeVisible({ timeout: 60000 });
    await trigger.click();
    const popover = page.getByRole('dialog', { name: language === 'en' ? 'Context window' : '上下文窗口', exact: true });
    await expect(popover.getByText('~65.5K', { exact: true })).toBeVisible();
    const bounds = await popover.boundingBox();
    expect(bounds.width).toBeLessThanOrEqual(272);
    expect(bounds.height).toBeLessThan(180);
    expect(bounds.x).toBeGreaterThanOrEqual(8);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8);
    await expect(popover.getByRole('meter')).toHaveAttribute('aria-valuenow', '45');
    await page.screenshot({ path: path.join(artifacts, `context-${language}-${theme}-${width}.png`) });
    await page.keyboard.press('Escape'); await expect(popover).toHaveCount(0); await expect(trigger).toBeFocused();
    await page.goto(`${baseUrl}/settings/general`);
    if (width < 640) await page.getByRole('navigation', { name: language === 'en' ? 'Settings' : '设置' }).getByRole('button', { name: language === 'en' ? 'General' : '通用', exact: true }).click();
    const card = page.locator('.general-workspace-card');
    const input = card.getByRole('textbox', { name: language === 'en' ? 'Working directory' : '工作目录' });
    await expect(input).toBeEnabled();
    await expect(input).toHaveAttribute('placeholder', '/fixture/PilotDeckGeneral');
    await input.fill('/fixture/custom');
    const save = card.getByRole('button', { name: language === 'en' ? 'Save' : '保存', exact: true });
    await expect(input).toHaveValue('/fixture/custom');
    await expect(save).toBeEnabled();
    await save.click(); await expect(save).toBeDisabled();
    await input.fill('/occupied'); await save.click();
    await expect(card.getByRole('alert')).toHaveText(language === 'en'
      ? 'This folder is not empty. Choose an empty folder; the current directory has not changed.'
      : '此文件夹非空，请选择空文件夹；当前目录未更改。');
    expect(directory).toBe('/fixture/custom');
    await card.getByRole('button', { name: language === 'en' ? 'Use default' : '使用默认目录', exact: true }).click();
    await expect(input).toHaveValue('');
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, `workspace-${language}-${theme}-${width}.png`) });
    expect(errors).toEqual([]);
    results.push({ language, theme, width, context: bounds });
    await context.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
