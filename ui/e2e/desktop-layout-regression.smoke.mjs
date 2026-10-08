// Vite on 5187. Compare unaffected clients against the PR's original desktop CSS.
// Native Mac geometry and caption interactions are covered by desktop-chrome.smoke.mjs.
import { chromium, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baselineRef = process.env.PILOTDECK_LAYOUT_BASE_REF || 'HEAD';
const originalCss = execFileSync('git', ['show', `${baselineRef}:ui/src/components/desktop/desktop.css`], { cwd: root, encoding: 'utf8' });
const artifacts = process.env.PILOTDECK_LAYOUT_ARTIFACTS || '/tmp/pilotdeck-desktop-layout-regression';
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PILOTDECK_TEST_BROWSER_CHANNEL || 'chrome', headless: true });
try {
  for (const platform of ['win32', 'linux', 'web', 'pwa', 'mobile']) {
    const context = await browser.newContext({ viewport: platform === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let onboarding = false;
    await page.addInitScript(platform => {
      localStorage.setItem('userLanguage', 'en');
      if ('serviceWorker' in navigator) navigator.serviceWorker.register = () => Promise.reject(new Error('Isolated test'));
      if (platform === 'win32' || platform === 'linux') {
        const caption = () => {
          document.documentElement.style.setProperty('--desktop-caption-height', '32px');
          document.documentElement.style.setProperty('--desktop-top-inset', '32px');
        };
        if (document.documentElement) caption(); else document.addEventListener('DOMContentLoaded', caption, { once: true });
        window.pilotdeckDesktop = { platform, getAppearance: () => ({ language: 'en', themeMode: 'light' }),
          setMenuState: async () => {}, onCommand: () => () => {}, setAppearance: async () => {}, getRuntimeInfo: async () => null,
          checkUpdates: async () => ({ current: { version: 'fixture' }, latest: null, hasUpdate: false, canDownload: false }),
          getUpdateStatus: async () => ({ state: 'idle', progress: 0 }) };
      }
      if (platform === 'pwa') {
        const match = window.matchMedia.bind(window);
        window.matchMedia = query => query === '(display-mode: standalone)' ? { ...match(query), matches: true, addEventListener() {}, removeEventListener() {} } : match(query);
      }
    }, platform);
    await page.route('**/api/**', async route => {
      const p = new URL(route.request().url()).pathname;
      let body = {};
      if (p === '/api/projects') body = [{ name: 'demo', displayName: 'Layout regression', kind: 'workspace', fullPath: '/fixture/demo', sessions: [], capabilities: { files: true } }];
      else if (p.includes('onboarding-status')) body = { hasCompletedOnboarding: !onboarding };
      else if (p === '/api/config') body = { exists: true, raw: JSON.stringify({ tools: { webSearch: { enabled: true, provider: 'serpapi' } } }), validation: { valid: true, errors: [], warnings: [] } };
      else if (p.includes('models')) body = { models: [] };
      else if (p.includes('skills')) body = { skills: [] };
      else if (p.includes('plugins')) body = { plugins: [] };
      else if (p.includes('sessions')) body = { sessions: [], hasMore: false, total: 0 };
      else if (p.includes('files')) body = [];
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.routeWebSocket('**/ws**', socket => socket.onMessage(() => {}));
    const compareOriginal = async selectors => {
      const styles = await page.evaluate(({ selectors, originalCss }) => {
        const sheet = document.querySelector('style[data-vite-dev-id$="/components/desktop/desktop.css"]');
        if (!sheet) throw new Error('Desktop stylesheet was not loaded');
        const currentCss = sheet.textContent;
        const read = () => selectors.map(selector => {
          const el = document.querySelector(selector); if (!el) return null;
          const s = getComputedStyle(el); const r = el.getBoundingClientRect();
          return { selector, rect: [r.x, r.y, r.width, r.height], padding: s.padding, background: s.background,
            border: s.border, radius: s.borderRadius, grid: s.gridTemplateRows, display: s.display };
        });
        const current = read(); sheet.textContent = originalCss; const original = read(); sheet.textContent = currentCss;
        return { current, original };
      }, { selectors, originalCss });
      expect(styles.current, platform).toEqual(styles.original);
    };
    await page.goto('http://127.0.0.1:5187/p/demo');
    await expect(page.locator('.app-shell')).toBeVisible();
    await compareOriginal(['.app-root', '.app-shell', '.project-sidebar', '.workspace-header']);
    await page.goto('http://127.0.0.1:5187/settings/general');
    if (platform === 'mobile') await page.locator('.settings-sidebar').getByRole('button', { name: 'General', exact: true }).click();
    await expect(page.locator('.general-page-content')).toBeVisible();
    await compareOriginal(['.pilotdeck-settings-app', '.settings-sidebar', '.settings-main', '.topbar']);
    await page.goto('http://127.0.0.1:5187/settings/about');
    await expect(page.locator('.settings-content')).toBeVisible();
    expect(await page.getByText('AGPL-3.0-only', { exact: true }).count()).toBe(0);
    await page.goto('http://127.0.0.1:5187/settings/agent-search');
    await expect(page.locator('#search-provider')).toBeVisible();
    expect(await page.locator('#search-provider option').count()).toBe(9);
    await expect(page.locator('#search-engine')).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('pilotDeckConfig.panels.tools.provider.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(artifacts, `${platform}-search.png`) });
    onboarding = true; await page.goto('http://127.0.0.1:5187');
    await expect(page.locator('.onboarding-shell')).toBeVisible();
    await expect.poll(() => page.locator('.content-page').evaluate(el => el.getAnimations().some(a => a.playState === 'running'))).toBe(false);
    await compareOriginal(['.onboarding-shell', '.onboarding-frame', '.setup-sidebar', '.setup-content', '.content-page']);
    expect(errors).toEqual([]);
    console.log(`PASS: ${platform} layout matches ${baselineRef}; search names/engines render without horizontal overflow`);
    await context.close();
  }
} finally { await browser.close(); }
