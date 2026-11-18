import { chromium, test, expect } from '@playwright/test';
import { WEB_SEARCH_PROVIDERS } from '../../src/pilot/config/webSearchProviders.ts';

test.use({ serviceWorkers: 'block' });

async function expectHorizontalFit(page, ...selectors) {
  for (const selector of ['html', ...selectors]) {
    const region = page.locator(selector);
    await expect(region).toBeVisible();
    await expect.poll(() => region.evaluate(element => {
      const { left, right } = element.getBoundingClientRect();
      return {
        clippedLeft: left < -1,
        clippedRight: right > document.documentElement.clientWidth + 1,
        horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
      };
    }), { message: `${selector} fits horizontally on ${page.url()}` }).toEqual({
      clippedLeft: false, clippedRight: false, horizontalOverflow: false,
    });
  }
}

async function verifyLayout(page, platform) {
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
      // Give the real standalone media rule nonzero insets on a desktop display.
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.style.setProperty('--safe-area-inset-top', '12px');
        document.documentElement.style.setProperty('--safe-area-inset-left', '8px');
        document.documentElement.style.setProperty('--safe-area-inset-right', '16px');
      }, { once: true });
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
  await page.goto('/p/demo');
  await expect(page.locator('.app-shell')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#root')).not.toHaveAttribute('data-pilotdeck-startup');
  if (platform === 'pwa') {
    expect(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches)).toBe(true);
    const root = page.locator('#root');
    await expect(root).toHaveCSS('padding-top', '12px');
    await expect(root).toHaveCSS('padding-left', '8px');
    await expect(root).toHaveCSS('padding-right', '16px');
  }
  await expectHorizontalFit(page, '.app-shell', '.app-main', '.pd-workspace-content');
  await page.goto('/settings/general');
  if (platform === 'mobile') await page.locator('.settings-sidebar').getByRole('button', { name: 'General', exact: true }).click();
  await expectHorizontalFit(page, '.settings-main', '.settings-content', '.general-page-content');
  await page.goto('/settings/about');
  const aboutContent = ['win32', 'linux'].includes(platform) ? '.desktop-update-card' : '.about-page-content';
  await expectHorizontalFit(page, '.settings-main', '.settings-content', aboutContent);
  await page.goto('/settings/agent-search');
  const provider = page.locator('#search-provider');
  await expect(provider).toHaveValue('serpapi');
  const options = await provider.locator('option').evaluateAll(nodes =>
    nodes.map(option => ({ value: option.value, label: option.label.trim() })));
  expect(options.map(option => option.value).sort()).toEqual([...WEB_SEARCH_PROVIDERS].sort());
  for (const { value, label } of options) {
    expect(label, value).not.toBe('');
    expect(label, value).not.toContain('pilotDeckConfig.');
  }
  await expect(page.locator('#search-engine')).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('pilotDeckConfig.panels.tools.provider.');
  await expectHorizontalFit(page, '.settings-main', '.settings-content', '.search-card');
  onboarding = true; await page.goto('/');
  await expect(page.locator('.desktop-prototype-shell')).toBeVisible();
  await expect.poll(() => page.locator('.content-page').evaluate(el => el.getAnimations().some(a => a.playState === 'running'))).toBe(false);
  await expectHorizontalFit(page, '.desktop-prototype-shell', '.onboarding-frame', '.setup-content', '.content-page');
  expect(errors).toEqual([]);
}

for (const platform of ['win32', 'linux', 'web', 'mobile']) {
  test(`${platform} keeps workspace, search settings and onboarding within the viewport`, async ({ page }) => {
    await verifyLayout(page, platform);
  });
}

test('pwa keeps workspace, search settings and onboarding within the standalone viewport', async ({ baseURL, channel }) => {
  // Use the full Chromium browser in headless mode. The headless shell cannot
  // create app windows. Start on a static asset so API mocks precede app boot.
  const appUrl = new URL('/manifest.json', baseURL);
  const context = await chromium.launchPersistentContext('', {
    channel: channel || 'chromium', headless: true, baseURL, serviceWorkers: 'block',
    args: [`--app=${appUrl.href}`],
  });
  try {
    await verifyLayout(context.pages()[0], 'pwa');
  } finally {
    await context.close();
  }
});
