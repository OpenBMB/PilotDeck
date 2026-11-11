import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

test.use({ serviceWorkers: 'block', viewport: { width: 1320, height: 900 } });

test('macOS caption covers sidebar whitespace and excludes only session text', async ({ page, context }) => {
  test.setTimeout(60_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.addInitScript(() => {
    localStorage.setItem('userLanguage', 'en');
    window.pilotdeckDesktop = {
      platform: 'darwin', getAppearance: () => ({ language: 'en', themeMode: 'light' }),
      getRuntimeStatus: () => ({ phase: 'ready', progress: 96 }),
      onRuntimeStatus: () => () => {},
      onCommand: callback => { window.deliverDesktopCommand = callback; return () => {}; },
      setMenuState: async () => {},
    };
  });
  await context.routeWebSocket('**/ws**', socket => socket.onMessage(() => {}));
  await context.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body = {};
    if (pathname === '/api/auth/status') body = { authDisabled: true };
    else if (pathname.includes('onboarding-status')) body = { hasCompletedOnboarding: true };
    else if (pathname === '/api/projects') body = [{ name: 'demo', displayName: 'Demo', fullPath: '/fixture/demo', sessions: [{ id: 'title', title: 'Short title', __provider: 'pilotdeck' }] }];
    else if (pathname.includes('messages')) body = { messages: [] };
    else if (pathname.includes('sessions')) body = { sessions: [], total: 0, hasMore: false };
    else if (pathname.includes('config')) body = { config: {} };
    else if (pathname.includes('providers') || pathname.includes('models')) body = { providers: [], models: [] };
    else if (pathname.includes('tasks')) body = { tasks: [] };
    else if (pathname.includes('skills') || pathname.includes('plugins')) body = { skills: [], plugins: [] };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/p/demo/c/title');
  await expect(page.locator('.workspace-header h1')).toHaveText('Short title', { timeout: 30_000 });
  await expect(page.locator('#root')).not.toHaveAttribute('data-pilotdeck-startup');
  // Exercise the real preload CSS in Chromium; native macOS hit testing is a
  // separate desktop-chrome smoke check, not simulated by DOM pointer events.
  const preloadPath = fileURLToPath(new URL('../../apps/desktop/src/preloadChrome.ts', import.meta.url)).replaceAll('\\', '/');
  await page.evaluate(async preloadPath => {
    const { installWindowChrome } = await import(`/@fs/${preloadPath}`);
    installWindowChrome('darwin', { on() {}, invoke: async () => {}, sendSync: channel => channel === 'pilotdeck:get-appearance'
      ? { language: 'en' } : { fullscreen: false, dark: false } });
  }, preloadPath);
  const caption = page.locator('#pilotdeck-window-caption');
  const title = page.locator('.workspace-header h1');
  await expect(title).toHaveCSS('-webkit-app-region', 'no-drag');
  await expect(page.locator('.workspace-header')).toHaveCSS('-webkit-app-region', 'drag');
  for (const width of [220, 119, 76, 360]) {
    const resizer = await page.locator('.sidebar-resizer').boundingBox();
    const current = await page.locator('.project-sidebar').evaluate(el => el.getBoundingClientRect().width);
    await page.mouse.move(resizer.x + resizer.width / 2, resizer.y + 180);
    await page.mouse.down();
    await page.mouse.move(resizer.x + resizer.width / 2 + width - current, resizer.y + 180);
    await page.mouse.up();
    await expect.poll(() => page.locator('.project-sidebar').evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(width);
    await expect(caption).toHaveCSS('width', `${Math.max(100, width)}px`);
    const geometry = await title.evaluate(el => {
      const text = document.createRange(); text.selectNodeContents(el);
      return { width: el.getBoundingClientRect().width, textWidth: text.getBoundingClientRect().width, columnWidth: el.parentElement.getBoundingClientRect().width };
    });
    expect(geometry.width).toBeLessThanOrEqual(Math.ceil(geometry.textWidth) + 1);
    expect(geometry.columnWidth - geometry.width).toBeGreaterThan(150);
    const controls = await page.locator('.workspace-header button').evaluateAll(elements => elements.filter(el => el.getBoundingClientRect().width > 0).map(el => {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { hit: el === hit || el.contains(hit), region: getComputedStyle(el).webkitAppRegion };
    }));
    for (const control of controls) expect(control, `Sidebar width: ${width}`).toEqual({ hit: true, region: 'no-drag' });
  }
  await title.dblclick();
  await expect(page.getByRole('textbox', { name: 'Rename Session' })).toBeVisible();
  await page.keyboard.press('Escape');
  await title.dblclick();
  await page.getByRole('textbox', { name: 'Rename Session' }).fill('A long conversation title '.repeat(12));
  await page.getByRole('textbox', { name: 'Rename Session' }).press('Enter');
  await page.setViewportSize({ width: 800, height: 900 });
  const clipped = await title.evaluate(el => ({ width: el.getBoundingClientRect().width,
    available: el.parentElement.getBoundingClientRect().width, scrollWidth: el.scrollWidth, overflow: getComputedStyle(el).textOverflow }));
  expect(clipped.width).toBeLessThanOrEqual(clipped.available);
  expect(clipped.scrollWidth).toBeGreaterThan(clipped.width);
  expect(clipped.overflow).toBe('ellipsis');
  await page.evaluate(() => window.deliverDesktopCommand('toggle-sidebar'));
  await expect(page.locator('.app-shell')).toHaveClass(/sidebar-hidden/);
  await expect(caption).toHaveCSS('width', '100px');
  await page.evaluate(() => document.documentElement.toggleAttribute('data-desktop-fullscreen', true));
  await expect(caption).toBeHidden();
  expect(errors).toEqual([]);
});
