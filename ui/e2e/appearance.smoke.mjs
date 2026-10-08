// Start Vite on 5187. Uses real Electron image IPC and actual settings routes.
import { _electron as electron, chromium, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-appearance-smoke-'));
// A previous installation used opaque panels. Upgrading must reveal a newly
// chosen background immediately, without requiring an extra mode switch.
await fs.writeFile(path.join(profile, 'appearance.json'), JSON.stringify({ language: 'zh-CN', themeMode: 'light', lightAppearance: { panelOpacity: 100 } }));
const artifacts = path.join(root, 'artifacts/appearance-regression');
await fs.mkdir(artifacts, { recursive: true });
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)(path.join(root, 'apps/desktop/node_modules/electron')),
  args: [path.join(root, 'apps/desktop/scripts/fixtures/appearance.cjs')],
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')), PILOTDECK_APPEARANCE_PROFILE: profile },
});
async function mockServer(page) {
  // Service-worker fetches bypass Playwright page routes. Keep synthetic API
  // and dashboard responses inside this isolated fixture rather than proxying
  // them to a real backend that is intentionally absent from the test.
  await page.context().addInitScript(() => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register = () => Promise.reject(new Error('Service workers disabled in isolated appearance test'));
  });
  await page.route('**/api/**', async route => {
    const p = new URL(route.request().url()).pathname;
    let body = {};
    if (p === '/api/projects') body = [{ name: 'demo', displayName: 'Appearance test', kind: 'workspace', fullPath: '/fixture/demo', sessions: [], capabilities: { files: true } }];
    else if (p.includes('onboarding-status')) body = { hasCompletedOnboarding: true };
    else if (p.includes('/config')) body = { config: { models: {}, agents: {}, tools: {} } };
    else if (p.includes('models')) body = { models: [] };
    else if (p.includes('/skills')) body = { skills: [] };
    else if (p.includes('/plugins')) body = { plugins: [] };
    else if (p.includes('/tasks')) body = { tasks: [] };
    else if (p.includes('/cron')) body = { jobs: [] };
    else if (p.includes('/sessions')) body = { sessions: [], hasMore: false, total: 0 };
    else if (p.includes('/files')) body = [];
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.routeWebSocket('**/ws**', socket => socket.onMessage(() => {}));
  await page.route('**/sw.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route(/\/memory-dashboard\//, async route => {
    const pathname = new URL(route.request().url()).pathname;
    const name = pathname.slice('/memory-dashboard/'.length);
    if (!['index.html', 'app.css', 'app.js', 'trace-i18n.js', 'assets/brand/logo.png'].includes(name)) return route.fulfill({ status: 404, body: '' });
    const body = await fs.readFile(path.join(root, 'src/context/memory/edgeclaw-memory-core/ui-source', name));
    await route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'application/javascript' : name.endsWith('.png') ? 'image/png' : 'text/html', body });
  });
}

async function verifyBackgroundAndSharedStyle(page, platform) {
  await page.getByRole('button', { name: '纯色', exact: true }).click();
  // The former gradient option is gone; solid and image are the only choices.
  await expect(page.getByRole('button', { name: '渐变', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '侧栏底色', exact: true }).click();
  await page.getByRole('textbox', { name: '侧栏底色 HEX' }).fill('#b9dfce');
  await page.keyboard.press('Escape');
  // A solid palette tints the window chrome only. Reading surfaces stay white.
  await expect.poll(() => page.locator('.settings-sidebar').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(193, 227, 212)');
  expect(await page.locator('html').getAttribute('data-light-background')).toBe('solid');
  expect(await page.locator('.settings-main').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
  expect(await page.locator('.settings-sidebar').evaluate(e => getComputedStyle(e).backgroundAttachment)).toBe('fixed');
  expect(await page.locator('.general-card').first().evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
  await page.screenshot({ path: path.join(artifacts, `${platform}-solid.png`) });
  await page.goto('http://127.0.0.1:5187/p/demo');
  await expect(page.locator('.workspace-header')).toBeVisible();
  expect(await page.locator('.project-sidebar').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(193, 227, 212)');
  expect(await page.locator('.pd-chat-canvas').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
  expect(await page.locator('.pd-composer-input-surface').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
  expect(await page.locator('.workspace-header').evaluate(e => getComputedStyle(e).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await page.screenshot({ path: path.join(artifacts, `${platform}-chat-solid.png`) });
  await page.goto('http://127.0.0.1:5187/settings/appearance');
  await expect(page.locator('.appearance-settings')).toBeVisible();
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-light-appearance');
  await page.getByRole('button', { name: '切换浅色并编辑', exact: true }).click();
  await expect.poll(() => page.locator('.settings-sidebar').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(193, 227, 212)');
  await page.reload();
  await expect(page.getByRole('button', { name: '侧栏底色', exact: true })).toContainText('#B9DFCE');
  // Choosing "local image" before uploading keeps the solid look (no white-out).
  await page.getByRole('button', { name: '本地图片', exact: true }).click();
  await expect(page.getByText('尚未选择图片。添加图片前，界面会保持纯色背景。', { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-light-background', 'solid');
  expect(await page.locator('.settings-sidebar').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(193, 227, 212)');
  expect(await page.locator('.settings-main').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
  await expect(page.getByRole('slider', { name: '界面透明度' })).toHaveCount(0);
  await verifyAppearanceAlignment(page);
  await page.getByRole('button', { name: '侧栏底色', exact: true }).click();
  const hex = page.getByRole('textbox', { name: '侧栏底色 HEX' });
  await hex.fill('#GGGGGG'); await hex.press('Enter');
  await expect(hex).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert')).toContainText('HEX');
  await hex.press('Escape');
  await expect(page.getByRole('button', { name: '侧栏底色', exact: true })).toContainText('#B9DFCE');
  console.log(`PASS: ${platform} white reading surfaces, empty-image fallback, dark isolation/reload, compact alignment and invalid-color validation`);
}

async function verifyAppearanceAlignment(page) {
  await expect(page.locator('.appearance-live-preview')).toHaveCount(0);
  const controls = await page.locator('.appearance-color-control,.appearance-segments').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect(); return { left: rect.left, width: rect.width, height: rect.height };
  }));
  expect(controls).toHaveLength(3);
  for (const control of controls) expect(control).toEqual(controls[0]);
  expect(controls[0].width).toBe(176); expect(controls[0].height).toBe(36);
}

async function chooseDesktopImage(application, page, filePaths) {
  await application.evaluate((_electron, filePaths) => {
    globalThis.filePickerResults = [{ canceled: !filePaths.length, filePaths }];
  }, filePaths);
  await page.getByRole('button', { name: /^(选择图片|替换图片)$/ }).click();
  await expect(page.locator('.appearance-settings input[type=file]')).not.toHaveAttribute('data-pilotdeck-file-picker');
  expect(await application.evaluate(() => globalThis.filePickerErrors)).toEqual([]);
}

async function verifyDesktopCaption(application, page) {
  if (process.platform !== 'win32' && process.platform !== 'linux') return;
  const native = await application.evaluate(() => globalThis.captionOverlay);
  const rgb = hex => `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
  await expect(page.locator('#pilotdeck-window-caption')).toHaveCSS('background-color', rgb(native.color));
  await expect(page.locator('#pilotdeck-window-caption')).toHaveCSS('color', rgb(native.symbolColor));
}
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await mockServer(page);
  await page.goto('http://127.0.0.1:5187/settings/appearance');
  await expect(page.locator('.appearance-settings')).toBeVisible({ timeout: 60000 });
  console.log('Desktop settings mounted');
  const pane = page.locator('.settings-content');
  expect(await pane.evaluate(e => getComputedStyle(e).overflowY)).toBe('auto');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 480));
  await pane.evaluate(e => { e.scrollTop = 500; });
  expect(await pane.evaluate(e => e.scrollTop)).toBeGreaterThan(0);
  await page.locator('.nav-item').filter({ hasText: '通用' }).click();
  await expect(page.locator('.general-settings-page')).toBeVisible();
  expect(await page.locator('.settings-content').evaluate(e => e.scrollTop)).toBe(0);
  await page.locator('.nav-item').filter({ hasText: '外观' }).click();
  await expect(page.locator('.appearance-settings')).toBeVisible();
  expect(await pane.evaluate(e => e.scrollTop)).toBe(0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 900));
  await verifyBackgroundAndSharedStyle(page, 'desktop');
  for (const [name, preset] of [['默认', 'default'], ['雾蓝', 'blue'], ['薄荷', 'mint'], ['暖杏', 'apricot'], ['淡紫', 'lavender'], ['玫瑰', 'rose'], ['自定义', 'custom']]) {
    await page.locator('#appearance-palette').getByRole('button', { name: name, exact: true }).click();
    if (name === '自定义') await page.keyboard.press('Escape');
    await expect(page.locator(`#appearance-palette [data-preset="${preset}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => window.pilotdeckDesktop.getAppearance().lightAppearance.preset)).toBe(preset);
    await verifyDesktopCaption(app, page);
    expect(await page.locator('.sidebar-brand').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  }
  console.log('PASS: all light presets share native button and HTML caption colors');
  await page.getByRole('button', { name: '本地图片', exact: true }).click();
  await chooseDesktopImage(app, page, []);
  await expect(page.locator('.appearance-image-upload img')).toHaveCount(0);
  for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
    const data = await page.evaluate(mime => {
      const c = document.createElement('canvas'); c.width = 400; c.height = 220;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#789ac4'; ctx.fillRect(0, 0, 400, 220);
      ctx.fillStyle = '#c789b5'; ctx.fillRect(150, 0, 250, 220);
      return c.toDataURL(mime).split(',')[1];
    }, mime);
    const selectedImage = path.join(profile, `test.${mime.split('/')[1]}`);
    await fs.writeFile(selectedImage, Buffer.from(data, 'base64'));
    await chooseDesktopImage(app, page, [selectedImage]);
    await expect(page.locator('.appearance-image-upload img')).toBeVisible();
    await expect(page.locator('.appearance-image-upload strong')).not.toContainText('正在');
    await expect(page.locator('.appearance-error')).toHaveCount(0);
    console.log(`Desktop upload passed: ${mime}`);
  }
  const config = JSON.parse(await fs.readFile(path.join(profile, 'appearance.json')));
  expect(config.lightAppearance.background.imageId).toMatch(/\.png$/);
  expect((await fs.readdir(path.join(profile, 'appearance-images'))).length).toBe(1);
  await page.reload();
  await expect(page.locator('.appearance-image-upload img')).toBeVisible();
  await expect(page.getByRole('button', { name: '透出背景', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '实底', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-panel-alpha'))).toBe('85%');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-content-alpha'))).toBe('90%');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-wallpaper'))).toContain('blob:');
  // Image intensity and the two panel opacities are one control now.
  await expect(page.getByRole('slider', { name: '图片强度' })).toHaveCount(0);
  await expect(page.getByText('面板透色细调', { exact: true })).toHaveCount(0);
  await page.getByRole('spinbutton', { name: '界面透明度 (%)' }).fill('5');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-panel-alpha'))).toBe('95%');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-content-alpha'))).toBe('95%');
  await page.getByRole('spinbutton', { name: '界面透明度 (%)' }).fill('40');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-panel-alpha'))).toBe('60%');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-content-alpha'))).toBe('65%');
  expect(await page.locator('.settings-main').evaluate(e => getComputedStyle(e).backgroundColor)).toContain('/ 0.65)');
  await expect(page.locator('.appearance-live-preview')).toHaveCount(0);
  await page.getByText('更多图片调整（亮度、饱和度、位置）', { exact: true }).click();
  await page.getByRole('spinbutton', { name: '图片亮度 (%)' }).fill('125');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-image-brightness'))).toBe('125%');
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-light-appearance');
  await expect(page.locator('html')).toHaveAttribute('data-desktop-dark');
  await verifyDesktopCaption(app, page);
  await page.getByRole('button', { name: '切换浅色并编辑', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-light-appearance');
  await expect(page.locator('html')).not.toHaveAttribute('data-desktop-dark');
  await verifyDesktopCaption(app, page);
  await page.locator('.appearance-advanced > summary').click();
  await page.getByLabel('减少动态效果', { exact: true }).selectOption('on');
  await expect(page.locator('html')).toHaveAttribute('data-reduced-motion');
  await page.getByRole('switch', { name: '使用硬件（3D）加速' }).click();
  await expect(page.getByText('设置已保存。完全退出并重新打开客户端后生效。', { exact: true })).toBeVisible();
  await page.locator('#appearance-palette [data-preset=mint]').click();
  await pane.evaluate(e => { e.scrollTop = 0; });
  await page.screenshot({ path: path.join(artifacts, 'desktop.png') });
  await page.goto('http://127.0.0.1:5187/p/demo');
  await expect(page.locator('.workspace-header')).toBeVisible();
  expect(await page.locator('.app-main').evaluate(e => getComputedStyle(e).backgroundColor)).toContain('/ 0.65)');
  expect(await page.locator('.sidebar-brand-row').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  expect(await page.locator('.app-main').evaluate(e => getComputedStyle(e).opacity)).toBe('1');
  await page.locator('.workspace-header button[aria-haspopup=menu]').click();
  await page.getByRole('menuitem', { name: /记忆|Memory/ }).click();
  const memory = page.frameLocator('iframe[title="Memory 面板"]');
  await expect(memory.locator('#appScrim')).toBeAttached({ timeout: 30000 });
  await expect(memory.locator('#pilotdeck-memory-appearance')).toBeAttached();
  expect(await memory.locator('html').evaluate(e => getComputedStyle(e).getPropertyValue('--accent').trim())).toBe('#187c65');
  await expect.poll(() => memory.locator('html').evaluate(e => getComputedStyle(e).getPropertyValue('--status-project').trim()), { timeout: 15000 }).toBe('#2563eb');
  await page.screenshot({ path: path.join(artifacts, 'memory.png') });
  expect(errors).toEqual([]);
  console.log('PASS: actual Electron PNG/JPEG/WebP upload, replacement, disk persistence, reload and independent settings scrolling');
} finally { await app.close(); }

const restarted = await electron.launch({
  executablePath: createRequire(import.meta.url)(path.join(root, 'apps/desktop/node_modules/electron')),
  args: [path.join(root, 'apps/desktop/scripts/fixtures/appearance.cjs')],
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')), PILOTDECK_APPEARANCE_PROFILE: profile },
});
try {
  const page = await restarted.firstWindow(); await mockServer(page);
  await page.goto('http://127.0.0.1:5187/settings/appearance');
  await expect(page.locator('.appearance-image-upload img')).toBeVisible({ timeout: 60000 });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-content-alpha'))).toBe('65%');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-panel-alpha'))).toBe('60%');
  await verifyDesktopCaption(restarted, page);
  await restarted.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
  await expect(page.locator('#pilotdeck-window-caption')).toBeHidden();
  await restarted.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false));
  await expect(page.locator('#pilotdeck-window-caption')).toBeVisible();
  await verifyDesktopCaption(restarted, page);
  expect(await page.evaluate(() => window.pilotdeckDesktop.getAppearanceCapabilities())).toEqual({ hardwareAcceleration: false });
  expect((await restarted.evaluate(({ app }) => app.getGPUFeatureStatus())).gpu_compositing).toMatch(/disabled/);
  const config = JSON.parse(await fs.readFile(path.join(profile, 'appearance.json')));
  await fs.unlink(path.join(profile, 'appearance-images', config.lightAppearance.background.imageId));
  await page.reload();
  await expect(page.getByText('找不到已保存的背景图片，当前使用背景底色。请选择新图片。')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-light-background', 'solid');
  const brokenImage = path.join(profile, 'invalid.png');
  await fs.writeFile(brokenImage, 'broken image');
  await chooseDesktopImage(restarted, page, [brokenImage]);
  await expect(page.getByRole('alert')).toContainText('有效 PNG');
  await chooseDesktopImage(restarted, page, [path.join(root, 'apps/desktop/resources/icons/icon.png')]);
  await expect(page.locator('.appearance-image-upload img')).toBeVisible();
  await expect(page.locator('.appearance-error')).toHaveCount(0);
  console.log('PASS: desktop process restart, GPU disabled at startup, missing/corrupt image recovery');
} finally { await restarted.close(); }

const browser = await chromium.launch({ channel: process.env.PILOTDECK_TEST_BROWSER_CHANNEL || 'msedge', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await mockServer(page);
  await page.addInitScript(() => {
    if (!localStorage.getItem('userLanguage')) localStorage.setItem('userLanguage', 'zh-CN');
    if (!localStorage.getItem('pilotdeck-light-appearance-v1')) localStorage.setItem('pilotdeck-light-appearance-v1', JSON.stringify({ panelOpacity: 100 }));
    // LAN HTTP browsers expose getRandomValues but not randomUUID.
    Object.defineProperty(crypto, 'randomUUID', { value: undefined });
  });
  await page.goto('http://127.0.0.1:5187/settings/appearance');
  await expect(page.locator('.appearance-settings')).toBeVisible({ timeout: 60000 });
  await verifyBackgroundAndSharedStyle(page, 'web');
  // Locale is selected by the application; set its supported persistence key.
  const labels = [['默认', 'default'], ['雾蓝', 'blue'], ['薄荷', 'mint'], ['暖杏', 'apricot'], ['淡紫', 'lavender'], ['玫瑰', 'rose']];
  for (const [name, preset] of labels) {
    await page.locator('#appearance-palette').getByRole('button', { name: name, exact: true }).click();
    if (name === '自定义') await page.keyboard.press('Escape');
    await expect(page.locator(`#appearance-palette [data-preset="${preset}"]`)).toHaveAttribute('aria-pressed', 'true');
  }
  await page.getByRole('button', { name: '本地图片', exact: true }).click();
  await page.locator('.appearance-settings input[type=file]').setInputFiles(path.join(root, 'apps/desktop/resources/icons/icon.png'));
  await expect(page.locator('.appearance-image-upload img')).toBeVisible();
  await page.reload();
  await expect(page.locator('.appearance-image-upload img')).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-panel-alpha'))).toBe('85%');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-content-alpha'))).toBe('90%');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-wallpaper'))).toContain('blob:');
  await expect(page.getByRole('button', { name: '透出背景', exact: true })).toHaveCount(0);
  await page.getByRole('spinbutton', { name: '界面透明度 (%)' }).fill('30');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-panel-alpha'))).toBe('70%');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-content-alpha'))).toBe('75%');
  await page.reload();
  await expect(page.locator('.appearance-image-upload img')).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-content-alpha'))).toBe('75%');
  await page.setViewportSize({ width: 390, height: 844 });
  const pane = page.locator('.settings-content');
  // Wait for the lazy route and persisted wallpaper before testing real wheel
  // scrolling; the initial Suspense placeholder is shorter than the viewport.
  await pane.hover();
  await page.mouse.wheel(0, 10000);
  await expect(page.getByRole('button', { name: '恢复默认', exact: true })).toBeInViewport();
  expect(await pane.evaluate(e => e.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.scrollingElement.scrollTop)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(artifacts, 'mobile.png') });
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect(page.locator('#appearance-palette [data-preset=default]')).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.locator('#appearance-palette [data-preset=default]')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => localStorage.setItem('userLanguage', 'en'));
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Follow System', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.locator('html')).toHaveAttribute('data-reduced-motion');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await expect(page.locator('html')).not.toHaveAttribute('data-reduced-motion');
  await page.screenshot({ path: path.join(artifacts, 'web-english.png') });
  console.log('PASS: browser six presets, IndexedDB upload/reload, one transparency control, reset and 390px responsive scroll');
} finally { await browser.close(); }
