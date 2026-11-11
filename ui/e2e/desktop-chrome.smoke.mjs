// Run with Vite on 127.0.0.1:5187 and compiled apps/desktop/dist.
// All app network traffic is synthetic; no real runtime or model is contacted.
import { _electron as electron, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mac = process.platform === 'darwin';
const platformName = mac ? 'mac' : process.platform === 'linux' ? 'linux' : 'windows';
const artifactDir = process.env.PILOTDECK_CHROME_ARTIFACTS || path.join(root, 'outputs/desktop-chrome-review');
await fs.mkdir(artifactDir, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-chrome-'));
const app = await electron.launch({
  timeout: 60_000,
  executablePath: createRequire(import.meta.url)(path.join(root, 'apps/desktop/node_modules/electron')),
  args: [path.join(root, 'apps/desktop/scripts/fixtures/desktop-chrome.cjs'),
    ...(process.env.PILOTDECK_CHROME_SCALE ? [`--force-device-scale-factor=${process.env.PILOTDECK_CHROME_SCALE}`] : []),
    ...(process.env.PILOTDECK_CHROME_OZONE ? [`--ozone-platform=${process.env.PILOTDECK_CHROME_OZONE}`] : []),
    ...(process.env.PILOTDECK_CHROME_DISABLE_SANDBOX ? ['--no-sandbox'] : []),
    ...(process.env.PILOTDECK_CHROME_DISABLE_GPU ? ['--disable-gpu', '--disable-dev-shm-usage'] : [])],
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')), PILOTDECK_CHROME_PROFILE: profile },
});
app.process().on('exit', (code, signal) => console.log('Electron exited', { code, signal }));
const errors = [];
let page;
try {
  page = await app.firstWindow();
  page.on('crash', () => console.error('Desktop renderer crashed'));
  page.on('console', message => { if (message.type() === 'error') console.error('Renderer:', message.text()); });
  page.on('requestfailed', request => console.error('Request failed:', request.url(), request.failure()));
  await expect.poll(() => app.evaluate(() => global.chromeTest.loaded()), { timeout: 30_000 }).toBe(true);
  const projects = [
    { name: 'general', displayName: 'General conversation', kind: 'general', fullPath: '/fixture/general', sessions: [], capabilities: { files: false } },
    { name: 'demo', displayName: 'Desktop design review', kind: 'workspace', fullPath: '/fixture/demo', sessions: [{ id: 'chrome-review', title: 'Native title review', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], capabilities: { files: true } },
  ];
  let completedOnboarding = true;
  const missing = new Set();
  const searchRequests = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body = {};
    if (url.pathname === '/api/projects') body = projects;
    else if (url.pathname === '/api/auth/status') body = { authDisabled: true, needsSetup: false };
    else if (url.pathname === '/api/search/global') {
      searchRequests.push(route.request().postDataJSON());
      body = {
        groups: { chats: [{ id: 'chat:demo:chrome-review', kind: 'chats', project: projects[1],
          title: 'Native title review', sessionId: 'chrome-review', snippet: 'Native search fixture' }], files: [] },
        counts: { chats: 1, files: 0 }, hasMore: { chats: false, files: false }, partial: [],
      };
    }
    else if (url.pathname.includes('onboarding-status')) body = { hasCompletedOnboarding: completedOnboarding };
    else if (url.pathname === '/api/settings/permissions') body = { success: true, permissions: { skipPermissions: false, allowedTools: [], deniedTools: [] } };
    else if (url.pathname.includes('/token-usage')) body = { used: 117000, total: 262144, effectiveTotal: 262144, state: 'ok' };
    else if (url.pathname.includes('/messages')) body = { messages: [], hasMore: false, total: 0,
      tokenUsage: { used: 117000, total: 262144, effectiveTotal: 262144, state: 'ok' },
      ...(url.searchParams.get('includeModelContext') === 'summary' ? {
        contextBreakdown: { systemTokens: 2200, toolsTokens: 10200, messageTokens: 65500 },
      } : {}),
    };
    else if (url.pathname.includes('/sessions')) body = { sessions: projects[1].sessions, hasMore: false, total: 1 };
    else if (url.pathname.includes('/files')) body = [];
    else if (url.pathname.includes('models')) body = { models: [] };
    else if (url.pathname.includes('/skills')) body = { skills: [] };
    else if (url.pathname.includes('/plugins')) body = { plugins: [] };
    else if (url.pathname.includes('/config')) body = { config: { models: {}, agents: {}, tools: {} } };
    else if (url.pathname.includes('/tasks')) body = { tasks: [] };
    else if (url.pathname.includes('/cron')) body = { jobs: [] };
    else missing.add(url.pathname);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/sw.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.routeWebSocket('**/ws**', socket => {
    socket.onMessage(message => {
      try {
        const parsed = JSON.parse(String(message));
        if (parsed.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      } catch {}
    });
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5187/p/demo/c/chrome-review');
  await expect(page.locator('.app-shell')).toBeVisible({ timeout: 60000 });
  await expect.poll(() => app.evaluate(() => global.chromeTest.state().ready)).toBe(true);
  const nativeFolderLabel = mac ? 'Open in Finder' : process.platform === 'win32' ? 'Open in File Explorer' : 'Open in File Manager';
  await page.locator('[data-sidebar-root]').getByText('Native title review', { exact: true }).click({ button: 'right' });
  const folderMenu = page.getByRole('menu', { name: 'Context menu', exact: true });
  await expect(folderMenu.getByRole('menuitem', { name: nativeFolderLabel, exact: true })).toBeVisible();
  await folderMenu.screenshot({ path: path.join(artifactDir, `${platformName}-sidebar-folder-menu-en.png`) });
  await folderMenu.getByRole('menuitem', { name: nativeFolderLabel, exact: true }).click();
  await expect.poll(() => app.evaluate(() => global.chromeTest.openedDirectories().at(-1))).toBe('/fixture/demo');
  const contextTrigger = page.locator('.pd-composer-context-control > button');
  await contextTrigger.click();
  const context = page.getByRole('dialog', { name: 'Context window', exact: true });
  await expect(context.getByRole('meter', { name: 'Context budget', exact: true })).toHaveAttribute('aria-valuenow', '45');
  for (const label of ['System instructions', 'Tool descriptions', 'Conversation']) {
    await expect(context.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(context.getByText('~2.2K', { exact: true })).toBeVisible();
  await expect(context.getByText('~117K / 262K', { exact: true })).toBeVisible();
  await expect(context.locator('dt')).toHaveCount(3);
  await expect(context.locator('button, input, pre, details')).toHaveCount(0);
  await page.screenshot({ path: path.join(artifactDir, `${platformName}-context-breakdown.png`) });
  await context.screenshot({ path: path.join(artifactDir, `${platformName}-context-summary-dark.png`) });
  await page.keyboard.press('Escape');
  await expect(context).toHaveCount(0);
  await page.evaluate(() => window.pilotdeckDesktop.setAppearance({ language: 'zh-CN', themeMode: 'light' }));
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.locator('[data-sidebar-root]').getByText('Native title review', { exact: true }).click({ button: 'right' });
  const folderMenuZh = page.getByRole('menu', { name: '操作菜单', exact: true });
  await expect(folderMenuZh.getByRole('menuitem', { name: mac ? '在 Finder 中打开' : process.platform === 'win32' ? '在文件资源管理器中打开' : '在文件管理器中打开', exact: true })).toBeVisible();
  await folderMenuZh.screenshot({ path: path.join(artifactDir, `${platformName}-sidebar-folder-menu-zh.png`) });
  await page.keyboard.press('Escape');
  await contextTrigger.click();
  const compactContext = page.getByRole('dialog', { name: '上下文窗口', exact: true });
  await expect(compactContext.getByRole('meter', { name: '上下文预算', exact: true })).toHaveAttribute('aria-valuenow', '45');
  for (const label of ['系统指令', '工具说明', '会话内容']) {
    await expect(compactContext.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(compactContext.getByText('~65.5K', { exact: true })).toBeVisible();
  await expect(compactContext.getByText('45%', { exact: true })).toBeVisible();
  const compactBounds = await compactContext.boundingBox();
  expect(compactBounds.width).toBeLessThanOrEqual(320);
  expect(compactBounds.height).toBeLessThan(200);
  await compactContext.screenshot({ path: path.join(artifactDir, `${platformName}-context-summary-light-zh.png`) });
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.pilotdeckDesktop.setAppearance({ language: 'en', themeMode: 'dark' }));
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-desktop-platform', process.platform);
  if (mac) await expect(page.locator('html')).toHaveAttribute('data-desktop-integrated', '');
  const geometry = await page.locator('.app-shell').evaluate(el => ({
    x: el.getBoundingClientRect().x, border: getComputedStyle(el).borderTopWidth,
    radius: getComputedStyle(el).borderTopLeftRadius,
  }));
  if (mac) expect(geometry).toEqual({ x: 0, border: '0px', radius: '0px' });
  else {
    expect(geometry.x).toBeCloseTo(6);
    expect(parseFloat(geometry.border)).toBeGreaterThan(0);
    expect(geometry.radius).toBe('14px');
  }
  const headerGeometry = () => page.locator('.workspace-header').evaluate(el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }));
  const mainHeader = await headerGeometry();
  if (mac) {
    expect(mainHeader).toEqual({ top: 0, bottom: 52 });
    await expect(page.locator('html')).toHaveAttribute('data-desktop-toolbar', '');
    await expect.poll(async () => page.locator('#pilotdeck-window-caption').evaluate(el => el.getBoundingClientRect().width))
      .toBe(await page.locator('.project-sidebar').evaluate(el => el.getBoundingClientRect().width));
    const verifyToolbarHitTargets = async () => {
      const targets = await page.locator('.workspace-header button, .workspace-header input, .compact-brand').evaluateAll(elements =>
        elements.filter(el => el.getBoundingClientRect().width && el.getBoundingClientRect().height).map(el => {
          const rect = el.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return { label: el.getAttribute('aria-label'), safe: rect.y + rect.height / 2 >= 52 || rect.x >= 100, hit: hit === el || el.contains(hit), region: getComputedStyle(el).webkitAppRegion };
        }));
      for (const target of targets) expect(target, JSON.stringify(target)).toMatchObject({ safe: true, hit: true, region: 'no-drag' });
    };
    for (const width of [76, 119, 120, 172, 173, 174, 200, 220, 360, 220]) {
      const resizer = await page.locator('.sidebar-resizer').boundingBox();
      const currentWidth = await page.locator('.project-sidebar').evaluate(el => el.getBoundingClientRect().width);
      await page.mouse.move(resizer.x + resizer.width / 2, resizer.y + 180);
      await page.mouse.down(); await page.mouse.move(resizer.x + resizer.width / 2 + width - currentWidth, resizer.y + 180); await page.mouse.up();
      await expect.poll(() => page.locator('.project-sidebar').evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(width);
      expect(await headerGeometry()).toEqual(mainHeader);
      expect(await page.locator('.sidebar-brand-row, .compact-brand').evaluate(el => el.getBoundingClientRect().bottom)).toBe(110);
      expect(await page.locator('.workspace-title').evaluate(el => el.getBoundingClientRect().left)).toBeGreaterThanOrEqual(100);
      await verifyToolbarHitTargets();
      await expect(page.locator('#pilotdeck-window-caption')).toHaveCSS('width', `${Math.max(100, width)}px`);
      if (width === 76) await page.screenshot({ path: path.join(artifactDir, 'mac-compact-sidebar.png') });
    }
    await expect(page.locator('#pilotdeck-window-caption')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    // The compact expansion control stays below the native window controls.
    const resizer = await page.locator('.sidebar-resizer').boundingBox();
    await page.mouse.move(resizer.x, resizer.y + 180); await page.mouse.down();
    await page.mouse.move(resizer.x - 144, resizer.y + 180); await page.mouse.up();
    await page.locator('.compact-brand').click();
    await expect(page.locator('.project-sidebar')).not.toHaveClass(/compact/);
    for (const factor of [0.8, 1.1, 1]) {
      await app.evaluate(({ BrowserWindow }, factor) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor), factor);
      await expect.poll(() => page.locator('.workspace-header').evaluate(el => Math.round(el.getBoundingClientRect().height))).toBe(52);
      await verifyToolbarHitTargets();
    }
    console.log('PASS: toolbar actions remain unobscured at 80%, 110% and 100% zoom');
    console.log('PASS: Mac header alignment remains stable at 10 sidebar widths');
  }
  const verifyOriginalContentStyle = async () => {
    const styles = await page.evaluate(() => {
      const root = document.documentElement;
      const platform = root.dataset.desktopPlatform;
      const read = () => ['.app-root', '.app-shell', '.project-sidebar', '.workspace-header', '.sidebar-brand-row'].map(selector => {
        const style = getComputedStyle(document.querySelector(selector));
        return [selector, style.backgroundImage, style.backgroundColor, style.borderTopWidth, style.borderRightWidth,
          style.borderColor, style.borderRadius, style.boxShadow, style.gridTemplateColumns, style.paddingLeft, style.paddingRight];
      });
      const desktop = read();
      delete root.dataset.desktopPlatform;
      const original = read();
      root.dataset.desktopPlatform = platform;
      return { desktop, original };
    });
    expect(styles.desktop).toEqual(styles.original);
  };
  if (!mac) await verifyOriginalContentStyle();
  if (!mac) {
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible())).toBe(false);
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)).toBe(true);
    const caption = page.locator('#pilotdeck-window-caption');
    await expect(caption.locator('button')).toHaveCount(5);
    await expect(caption).toHaveCSS('background-color', 'rgb(43, 44, 46)');
    await expect(page.locator('.project-sidebar')).toHaveCSS('background-color', 'rgb(43, 44, 46)');
    // Both platforms delegate popup rendering and keyboard navigation to Electron.
    const menuCycle = [['File', 'menu-file'], ['Edit', 'menu-edit'], ['View', 'menu-view']];
    // Exercise repeated native teardown before reusing the same caption entries.
    for (const [label, id] of [...menuCycle, ...menuCycle, ...menuCycle]) {
      console.log(`[desktop-chrome] opening native ${id}`);
      await caption.getByRole('button', { name: label, exact: true }).click();
      await expect(caption.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-expanded', 'true');
      // Avoid main-process debugger evaluation inside the native popup loop.
      // Renderer IPC acknowledges closure after the native teardown completes.
      await page.evaluate(() => window.pilotdeckChromeFixture.closeMenu());
      // Native closePopup completes asynchronously (notably GTK/X11). Wait for
      // the real close callback and renderer state before the next mouse click.
      await expect(caption.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-expanded', 'false');
      await expect.poll(() => app.evaluate(() => global.chromeTest.menuRequests().at(-1)?.id)).toBe(id);
      console.log(`[desktop-chrome] closed native ${id}`);
    }
    await page.keyboard.press('F10');
    await page.evaluate(() => window.pilotdeckChromeFixture.closeMenu());
    await expect.poll(() => app.evaluate(() => global.chromeTest.menuRequests().at(-1)?.id)).toBe('all');
    await expect(page.locator('#pilotdeck-linux-popup')).toHaveCount(0);
  }
  const command = async id => {
    await expect.poll(() => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id)?.enabled, id)).toBe(true);
    await app.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id).click(), id);
  };
  const closeGlobalSearch = async () => {
    const dialog = page.locator('[data-global-search]');
    // Visibility precedes the dialog's scheduled focus. Sending Escape before
    // focus arrives targets the sidebar and leaves the native menu blocked.
    await expect(dialog.getByRole('combobox')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => app.evaluate(() => global.chromeTest.state().blocked)).toBe(false);
  };
  if (!mac) {
    const caption = page.locator('#pilotdeck-window-caption');
    await expect(caption).toHaveCSS('height', '32px');
    await command('help-about');
    const firstAbout = await app.evaluate(() => global.chromeTest.about().dialogs.at(-1));
    expect(firstAbout.detail).toContain('AGPL-3.0-only');
    expect(firstAbout.detail).toContain('2026.930.0-test');
    expect(firstAbout.detail).toContain('abc123fixtur');
    await app.evaluate(() => { global.aboutResponse = 1; });
    await command('help-about');
    await expect.poll(() => app.evaluate(() => global.chromeTest.about().copiedVersion)).toContain('Commit: abc123fixture');
    await app.evaluate(() => { global.aboutResponse = 2; });
    await command('help-about');
    await expect.poll(() => app.evaluate(() => global.chromeTest.about().openedWebsite)).toBe('https://github.com/OpenBMB/PilotDeck');
    console.log('PASS: compact caption and rich About dialog, version copy and project link');
  }
  if (process.env.PILOTDECK_CHROME_MANUAL === '1') {
    await page.evaluate(() => window.pilotdeckDesktop.setAppearance({ language: 'zh-CN', themeMode: 'light' }));
    await page.reload();
    await page.goto('http://127.0.0.1:5187/p/demo/c/chrome-review');
    await expect(page.locator('.workspace-header h1')).toHaveAttribute('data-desktop-no-drag', '');
    console.log('Native review window ready; waiting for manual inspection.');
    await new Promise(resolve => setTimeout(resolve, Number(process.env.PILOTDECK_CHROME_MANUAL_WAIT_MS) || 120000));
    await page.evaluate(() => window.pilotdeckDesktop.setAppearance({ language: 'en', themeMode: 'dark' }));
    await page.reload();
  }
  await command('new-project');
  await expect(page.locator('.create-workspace-dialog')).toBeVisible();
  await expect.poll(() => app.evaluate(() => global.chromeTest.state().blocked)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('.create-workspace-dialog')).toHaveCount(0);
  await expect.poll(() => app.evaluate(() => global.chromeTest.state().blocked)).toBe(false);
  await page.goto('http://127.0.0.1:5187/p/demo/c/chrome-review');
  const title = page.locator('.workspace-header h1');
  await expect(title).toHaveAttribute('data-desktop-no-drag', '');
  // DOM dblclick alone cannot detect Electron's native hit-test interception.
  expect(await title.evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('no-drag');
  expect(await page.locator('.workspace-header').evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('drag');
  if (mac) {
    const titleWidth = await title.evaluate(el => {
      const text = document.createRange(); text.selectNodeContents(el);
      return { box: el.getBoundingClientRect().width, text: text.getBoundingClientRect().width };
    });
    expect(titleWidth.box).toBeLessThanOrEqual(Math.ceil(titleWidth.text) + 1);
  }
  await title.dblclick();
  await expect(page.getByRole('textbox', { name: 'Rename Session' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('http://127.0.0.1:5187/p/demo');
  await expect.poll(() => app.evaluate(() => global.chromeTest.state().hasProject)).toBe(true);
  await page.locator('.workspace-actions').getByRole('button', { name: 'Files', exact: true }).click();
  await expect.poll(() => app.evaluate(() => global.chromeTest.state().canFind)).toBe(true);
  expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('find').enabled)).toBe(true);
  await command('find');
  await expect(page.locator('[data-global-search]')).toBeVisible();
  await closeGlobalSearch();
  await command('chat');
  await page.goto('http://127.0.0.1:5187/p/demo/c/chrome-review');
  await expect(page.locator('.workspace-actions').getByRole('button', { name: 'Search current conversation', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Search PilotDeck', exact: true }).click();
  await expect(page.locator('[data-global-search]')).toBeVisible();
  await page.getByRole('combobox', { name: 'Search chats and files' }).fill('Native');
  await expect.poll(() => searchRequests.at(-1)?.query).toBe('Native');
  await expect(page.getByRole('option', { name: /Native search fixture/ })).toBeVisible();
  await closeGlobalSearch();
  await page.keyboard.press(mac ? 'Meta+f' : 'Control+f');
  await expect(page.locator('[data-global-search]')).toBeVisible();
  await closeGlobalSearch();
  await command('new-conversation');
  await expect(page).toHaveURL(/\/p\/demo$/);
  await command('toggle-sidebar');
  await expect(page.locator('.app-shell')).toHaveClass(/sidebar-hidden/);
  await expect(page.locator('html')).not.toHaveAttribute('data-desktop-integrated');
  if (mac) {
    expect(await headerGeometry()).toEqual(mainHeader);
    expect(await page.locator('.workspace-header > button').first().evaluate(el => el.getBoundingClientRect().left)).toBe(100);
    await page.locator('.workspace-header > button').first().click();
    await expect(page.locator('.project-sidebar')).toBeVisible();
    await command('toggle-sidebar');
  }
  await command('toggle-sidebar');
  if (mac) await expect(page.locator('html')).toHaveAttribute('data-desktop-integrated', '');
  await command('check-updates');
  await expect(page).toHaveURL(/\/settings\/about$/);
  await expect(page.locator('.pilotdeck-settings-app')).toBeVisible();
  await expect.poll(() => app.evaluate(() => global.chromeTest.checks())).toBeGreaterThan(0);
  if (mac) await expect(page.locator('.pilotdeck-settings-app')).toHaveCSS('border-top-left-radius', '0px');
  if (mac) {
    const settingsHeader = await page.locator('.settings-main > .topbar').evaluate(el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }));
    expect(settingsHeader).toEqual(mainHeader);
    await expect(page.getByText('abc123fixtur', { exact: true })).toBeVisible();
    await expect(page.getByText('AGPL-3.0-only', { exact: true })).toBeVisible();
    const logoGeometry = selector => page.locator(selector).evaluate(el => {
      const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const settingsLogo = await logoGeometry('.sidebar-brand .brand-wordmark');
    expect(settingsLogo).toMatchObject({ x: 24, y: 66.5, height: 24 });
    expect(settingsLogo.width).toBeLessThan(165);
    await expect(page.locator('.sidebar-brand .brand-wordmark-image:visible')).toHaveCSS('width', '152px');
    await page.goto('http://127.0.0.1:5187/p/demo');
    await expect(page.locator('.sidebar-brand-row')).toBeVisible();
    expect(await logoGeometry('.brand-lockup')).toEqual(settingsLogo);
    await page.goto('http://127.0.0.1:5187/settings/about');
    await expect(page.getByText('AGPL-3.0-only', { exact: true })).toBeVisible();
    console.log('PASS: workspace/settings wordmarks share the smaller size and x/y alignment');
  }
  const previousChecks = await app.evaluate(() => global.chromeTest.checks());
  await command('check-updates');
  await expect.poll(() => app.evaluate(() => global.chromeTest.checks())).toBeGreaterThan(previousChecks);
  await page.screenshot({ path: path.join(artifactDir, `${platformName}-settings.png`) });
  await command('chat');
  await expect(page.locator('.app-shell')).toBeVisible();
  await page.goto('http://127.0.0.1:5187/p/demo');
  await expect(page.locator('.workspace-header h1')).toHaveText('Desktop design review');
  const pageIdentity = () => page.evaluate(() => ({
    path: location.pathname,
    title: document.querySelector('.workspace-header h1')?.textContent?.trim(),
    hasShell: Boolean(document.querySelector('.app-shell')),
    hasSidebar: Boolean(document.querySelector('.project-sidebar')),
  }));
  const darkPageIdentity = await pageIdentity();
  await page.screenshot({ path: path.join(artifactDir, `${platformName}-dark.png`) });
  await page.evaluate(() => window.pilotdeckDesktop.setAppearance({ language: 'en', themeMode: 'light' }));
  await expect(page.locator('html')).not.toHaveAttribute('data-desktop-dark');
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)).toBe(false);
  // ThemeContext consumes the persisted desktop appearance on reload.
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await expect(page.locator('.workspace-header h1')).toHaveText('Desktop design review');
  expect(await pageIdentity()).toEqual(darkPageIdentity);
  await page.screenshot({ path: path.join(artifactDir, `${platformName}-light.png`) });
  if (!mac) {
    await expect(page.locator('#pilotdeck-window-caption')).toHaveCSS('background-color', process.platform === 'win32' ? 'rgba(0, 0, 0, 0)' : 'rgb(244, 244, 245)');
    await verifyOriginalContentStyle();
    await expect(page.locator('.project-sidebar')).toHaveCSS('background-image', 'linear-gradient(rgb(251, 250, 255), rgb(244, 243, 255) 58%, rgb(240, 244, 255))');

    // Exercise the actual i18n instance, including persistence across reload.
    await page.evaluate(async () => { const { default: i18n } = await import('/src/i18n/config.js'); await i18n.changeLanguage('zh-CN'); });
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.locator('#pilotdeck-window-caption button')).toHaveText(['文件', '编辑', '查看', '前往', '帮助']);
    await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('menu-file').label)).toBe('文件');
    expect(await app.evaluate(({ Menu }) => [
      Menu.getApplicationMenu().getMenuItemById('new-conversation').label,
      Menu.getApplicationMenu().getMenuItemById('help-docs').label,
    ])).toEqual(['新对话', '使用文档']);

    await page.reload();
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('#pilotdeck-window-caption button')).toHaveText(['文件', '编辑', '查看', '前往', '帮助']);
    await page.screenshot({ path: path.join(artifactDir, `${platformName}-light-zh.png`) });
    await page.evaluate(async () => { const { default: i18n } = await import('/src/i18n/config.js'); await i18n.changeLanguage('en'); });
    await expect(page.locator('#pilotdeck-window-caption button')).toHaveText(['File', 'Edit', 'View', 'Go', 'Help']);
    await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('menu-file').label)).toBe('&File');
    expect(await app.evaluate(({ Menu }) => [
      Menu.getApplicationMenu().getMenuItemById('new-conversation').label,
      Menu.getApplicationMenu().getMenuItemById('help-docs').label,
    ])).toEqual(['New Conversation', 'Documentation']);
    const safeArea = await page.locator('#pilotdeck-window-caption').evaluate(el => ({
      left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, width: innerWidth,
    }));
    expect(safeArea.left > 80 || safeArea.right < safeArea.width - 80).toBe(true);
    if (process.platform === 'win32') {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize());
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(false);
    }
  }
  const simulateFullscreen = process.env.PILOTDECK_CHROME_SIMULATE_FULLSCREEN === '1';
  if (simulateFullscreen) {
    console.log('INFO: fullscreen IPC simulation requested; this run does not validate a native fullscreen transition');
    await app.evaluate(({ BrowserWindow, nativeTheme }) => BrowserWindow.getAllWindows()[0].webContents.send('pilotdeck:window-state', { fullscreen: true, dark: nativeTheme.shouldUseDarkColors }));
  } else {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), { timeout: 15000 }).toBe(true);
  }
  await expect(page.locator('html')).toHaveAttribute('data-desktop-fullscreen', '');
  await expect(page.locator('#pilotdeck-window-caption')).toBeHidden();
  await expect(page.locator('.app-root')).toHaveCSS('padding-top', mac ? '0px' : '6px');
  if (mac) expect(await headerGeometry()).toEqual({ top: 0, bottom: 52 });
  if (simulateFullscreen) await app.evaluate(({ BrowserWindow, nativeTheme }) => BrowserWindow.getAllWindows()[0].webContents.send('pilotdeck:window-state', { fullscreen: false, dark: nativeTheme.shouldUseDarkColors }));
  else await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false));
  await expect(page.locator('html')).not.toHaveAttribute('data-desktop-fullscreen');
  if (!mac) await expect(page.locator('.app-root')).toHaveCSS('padding-top', '38px');
  if (mac) expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getWindowButtonPosition())).toEqual({ x: 16, y: 18 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  await expect(page.locator('.app-shell')).toBeVisible();
  completedOnboarding = false;
  await page.reload();
  await expect(page.locator('.desktop-prototype-shell')).toBeVisible();
  // Visibility starts during the loading screen's fade. Measure only after
  // that transition releases the real page and its first layout is painted.
  await expect(page.locator('#root')).not.toHaveAttribute('data-pilotdeck-startup');
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  if (mac) {
    await expect(page.locator('html')).not.toHaveAttribute('data-desktop-toolbar');
    await expect(page.locator('#pilotdeck-window-caption')).toHaveCSS('width', `${await page.evaluate(() => innerWidth)}px`);
  }
  await expect.poll(() => page.locator('.content-page').evaluate(page =>
    page.getAnimations().some(animation => animation.playState === 'running'))).toBe(false);
  const onboardingGeometry = await page.evaluate(() => {
    const shell = document.querySelector('.desktop-prototype-shell');
    const content = document.querySelector('.setup-content');
    return {
      scrollHeight: document.scrollingElement.scrollHeight,
      viewportHeight: window.innerHeight,
      shellBottom: shell.getBoundingClientRect().bottom,
      shellHeight: shell.getBoundingClientRect().height,
      contentScrollHeight: content.scrollHeight,
      contentClientHeight: content.clientHeight,
    };
  });
  if (onboardingGeometry.contentScrollHeight > onboardingGeometry.contentClientHeight + 1) {
    console.error('Onboarding layout overflow:', onboardingGeometry, await page.locator('.content-page').evaluate(el => ({
      rect: el.getBoundingClientRect().toJSON(), transform: getComputedStyle(el).transform,
      animations: el.getAnimations().map(animation => ({ state: animation.playState, time: animation.currentTime })),
    })));
  }
  expect(onboardingGeometry.scrollHeight).toBeLessThanOrEqual(onboardingGeometry.viewportHeight + 1);
  expect(onboardingGeometry.shellBottom).toBeLessThanOrEqual(onboardingGeometry.viewportHeight + 1);
  expect(onboardingGeometry.contentScrollHeight).toBeLessThanOrEqual(onboardingGeometry.contentClientHeight + 1);
  if (!mac) {
    expect(onboardingGeometry.shellHeight).toBeLessThan(onboardingGeometry.viewportHeight);
  }
  if (mac) {
    for (const selector of ['.onboarding-frame', '.setup-sidebar', '.setup-content']) {
      expect(await page.locator(selector).evaluate(el => el.getBoundingClientRect().top)).toBe(0);
    }
  }
  await page.screenshot({ path: path.join(artifactDir, `${platformName}-onboarding.png`) });
  await page.setViewportSize({ width: 960, height: 640 });
  const compactOnboardingGeometry = await page.evaluate(() => ({
    scrollHeight: document.scrollingElement.scrollHeight,
    viewportHeight: innerHeight,
    frameBottom: document.querySelector('.onboarding-frame').getBoundingClientRect().bottom,
  }));
  expect(compactOnboardingGeometry.scrollHeight).toBeLessThanOrEqual(compactOnboardingGeometry.viewportHeight + 1);
  expect(compactOnboardingGeometry.frameBottom).toBeLessThanOrEqual(compactOnboardingGeometry.viewportHeight + 1);
  await page.screenshot({ path: path.join(artifactDir, `${platformName}-onboarding-compact.png`) });
  await page.locator('.welcome-action button').click();
  await page.locator('.provider-card.custom-provider').click();
  await page.locator('.content-page').getByRole('button', { name: /continue|继续/i }).click();
  const addModel = page.locator('.add-model-button');
  for (const { width, height, zoom } of [
    { width: 960, height: 740, zoom: 1 },
    { width: 960, height: 640, zoom: 1 },
    { width: 960, height: 640, zoom: 1.1 },
  ]) {
    await page.setViewportSize({ width, height });
    await app.evaluate(({ BrowserWindow }, factor) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor), zoom);
    await expect(addModel).toBeVisible();
    await addModel.scrollIntoViewIfNeeded();
    await expect(addModel).toBeInViewport();
    const layout = await page.evaluate(() => {
      const frame = document.querySelector('.onboarding-frame').getBoundingClientRect();
      const form = document.querySelector('.connection-form');
      return {
        width: innerWidth,
        viewportHeight: innerHeight,
        documentHeight: document.scrollingElement.scrollHeight,
        frameTop: frame.top,
        frameBottom: frame.bottom,
        formScrollTop: form.scrollTop,
        formScrollable: form.scrollHeight > form.clientHeight,
      };
    });
    expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
    expect(layout.frameTop).toBeGreaterThanOrEqual(-1);
    expect(layout.frameBottom).toBeLessThanOrEqual(layout.viewportHeight + 1);
    if (height === 640 && zoom === 1) {
      expect(layout.formScrollable).toBe(true);
      expect(layout.formScrollTop).toBeGreaterThan(0);
    }
    if (zoom > 1) expect(layout.width).toBeLessThanOrEqual(900);
  }
  await addModel.click();
  await expect(page.locator('.model-chip-input')).toBeVisible();
  await page.locator('.model-chip-input').fill('example-model');
  await page.locator('.model-chip-input').press('Enter');
  await expect(page.locator('.selected-model-name', { hasText: 'example-model' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-desktop-platform', process.platform);
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, geometry, unmappedFixtureEndpoints: [...missing], artifactDir }));
} catch (error) {
  console.error('Desktop chrome failure:', { url: page?.url(), errors });
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(artifactDir, `${platformName}-failure.png`), timeout: 5000 }).catch(() => {});
  }
  throw error;
} finally {
  await app.close();
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
