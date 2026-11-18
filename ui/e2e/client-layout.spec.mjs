import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

for (const platform of ['win32', 'linux', 'web', 'pwa', 'mobile']) {
  test(`${platform} keeps workspace, search settings and onboarding within the viewport`, async ({ page }) => {
    await page.setViewportSize(platform === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let onboarding = false;
    await page.addInitScript(platform => {
      localStorage.setItem('userLanguage', 'en');
      if (platform === 'win32' || platform === 'linux') {
        const caption = () => {
          document.documentElement.style.setProperty('--desktop-caption-height', '32px');
          document.documentElement.style.setProperty('--desktop-top-inset', '32px');
        };
        if (document.documentElement) caption(); else document.addEventListener('DOMContentLoaded', caption, { once: true });
        window.pilotdeckDesktop = { platform, getAppearance: () => ({ language: 'en', themeMode: 'light' }),
          getRuntimeStatus: () => ({ phase: 'ready', progress: 96 }), onRuntimeStatus: () => () => {},
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
      if (p === '/api/auth/status') body = { authDisabled: true };
      else if (p === '/api/projects') body = [{ name: 'demo', displayName: 'Layout fixture', kind: 'workspace', fullPath: '/fixture/demo', sessions: [], capabilities: { files: true } }];
      else if (p === '/api/settings/general-workspace') body = { directory: '', effectiveDirectory: '/fixture/PilotDeckGeneral', defaultDirectory: '/fixture/PilotDeckGeneral' };
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
    const withinViewport = async () => {
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    };
    await page.goto('/p/demo');
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#root')).not.toHaveAttribute('data-pilotdeck-startup');
    await withinViewport();
    await page.goto('/settings/general');
    if (platform === 'mobile') await page.locator('.settings-sidebar').getByRole('button', { name: 'General', exact: true }).click();
    await expect(page.locator('.general-page-content')).toBeVisible();
    await withinViewport();
    await page.goto('/settings/about');
    await expect(page.locator('.settings-content')).toBeVisible();
    await withinViewport();
    await page.goto('/settings/agent-search');
    const provider = page.locator('#search-provider');
    await expect(provider).toHaveValue('serpapi');
    const options = await provider.locator('option').allTextContents();
    expect(options.length).toBeGreaterThan(0);
    expect(options.every(label => label.trim() && !label.includes('pilotDeckConfig.'))).toBe(true);
    await expect(page.locator('#search-engine')).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('pilotDeckConfig.panels.tools.provider.');
    await withinViewport();
    onboarding = true; await page.goto('/');
    await expect(page.locator('.desktop-prototype-shell')).toBeVisible();
    await expect.poll(() => page.locator('.content-page').evaluate(el => el.getAnimations().some(a => a.playState === 'running'))).toBe(false);
    await withinViewport();
    expect(errors).toEqual([]);
  });
}
