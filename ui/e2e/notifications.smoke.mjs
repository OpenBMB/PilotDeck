// Run Vite on 5187, then execute this script. All API responses and OS surfaces are isolated.
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { buildSystemNotification } from '../shared/notifications.js';
const artifacts = '/tmp/pilotdeck-notifications-qa';
const origin = process.env.PILOTDECK_SMOKE_URL || 'http://127.0.0.1:5187';
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ permissions: ['notifications'], viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
const consoleErrors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)); });
page.on('crash', () => consoleErrors.push('Renderer crashed'));
let socket;
await page.routeWebSocket('**/ws**', ws => {
  socket = ws;
  ws.onMessage(raw => {
    const message = JSON.parse(raw);
    if (message.type === 'get-session-activity') ws.send(JSON.stringify({ type: 'session-activity-snapshot', scope: '1', activities: [] }));
  });
});
const mockApi = async route => {
  const p = new URL(route.request().url()).pathname;
  let body = {};
  if (p === '/api/projects') body = [{ name: 'demo', displayName: 'Demo', fullPath: '/fixture/demo', kind: 'workspace', sessions: [{ id: 's1', title: 'Report' }], capabilities: { files: true } }];
  else if (p.includes('onboarding-status')) body = { hasCompletedOnboarding: true };
  else if (p.includes('sessions')) body = { sessions: [], messages: [], hasMore: false, total: 0 };
  else if (p === '/api/config') body = { exists: true, raw: 'agent:\n  model: fixture/test\n', validation: { valid: true, errors: [] } };
  else if (p.includes('/skills') || p.includes('/plugins')) body = { skills: [], plugins: [] };
  else if (p.includes('models') || p.includes('providers')) body = { providers: [], models: [] };
  // Deliberately fail registration: live browser notifications must remain functional.
  else if (p.includes('vapid-public-key')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
};
await page.route('**/api/**', mockApi);
await page.addInitScript(() => { localStorage.setItem('userLanguage', 'zh-CN'); if (!localStorage.getItem('themeMode')) localStorage.setItem('themeMode', 'light'); });
try {
  await page.goto(`${origin}/settings/general`);
  const card = page.getByRole('article', { name: '通知', exact: true });
  await expect(card).toBeVisible({ timeout: 25000 });
  await expect(card.getByRole('switch')).toHaveCount(3);
  await expect(card.getByRole('button', { name: /测试/ })).toHaveCount(0);
  await expect(card.getByRole('switch', { name: '通知提示音', exact: true })).toBeDisabled();
  await expect(card.getByRole('switch', { name: '显示应用图标角标', exact: true })).toHaveCount(0);
  await page.evaluate(() => navigator.serviceWorker.ready);
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(() => {
    self.__notifications = [];
    self.registration.showNotification = async (title, options) => { self.__notifications.push({ title, ...options }); };
    self.registration.getNotifications = async () => [];
  });
  await card.getByRole('switch', { name: '启用系统通知', exact: true }).click();
  await expect(card.getByRole('switch', { name: '启用系统通知', exact: true })).toHaveAttribute('aria-checked', 'true');
  const notification = { id: 'r1', sessionId: 's1', scope: '1', kind: 'completed', sessionName: 'Report', preview: 'Report is ready', createdAt: new Date().toISOString() };
  socket.send(JSON.stringify({ type: 'session-notification', notification }));
  await expect.poll(() => worker.evaluate(() => self.__notifications.length)).toBe(1);
  await expect(page).toHaveTitle('PilotDeck');
  // A Web Push copy of the same event must not display a second notification.
  await worker.evaluate(async payload => { await showNotificationOnce(payload); }, buildSystemNotification(notification, {}, 'zh-CN'));
  expect(await worker.evaluate(() => self.__notifications.length)).toBe(1);
  await card.getByRole('switch', { name: '显示消息预览', exact: true }).click();
  await expect(card.getByRole('switch', { name: '显示消息预览', exact: true })).toHaveAttribute('aria-checked', 'false');
  socket.send(JSON.stringify({ type: 'session-notification', notification: { ...notification, id: 'r2', kind: 'question', preview: 'Sensitive question', createdAt: new Date().toISOString() } }));
  await expect.poll(() => worker.evaluate(() => self.__notifications.length)).toBe(2);
  const displayed = await worker.evaluate(() => self.__notifications.at(-1));
  expect(displayed.body).not.toContain('Sensitive question');
  expect(displayed.body).toContain('请回答后继续');
  await expect(page).toHaveTitle('PilotDeck');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${artifacts}/settings-web-light.png`, fullPage: true });
  await page.goto(`${origin}/settings/appearance`);
  await page.locator('[data-mode=dark]').click();
  await page.goto(`${origin}/settings/general`);
  await page.getByRole('article', { name: '通知', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({ path: `${artifacts}/settings-web-dark.png`, fullPage: true });
  // The actual worker database retains one pending conversation across reloads.
  expect(await worker.evaluate(() => notificationState(state => Object.keys(state.pending).length))).toBe(1);
  await page.reload();
  await expect(page.getByRole('article', { name: '通知', exact: true })).toBeVisible();
  await expect(page).toHaveTitle('PilotDeck');
  // Click routing focuses the existing page and navigates to the right conversation.
  await worker.evaluate(async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    windows[0].postMessage({ type: 'notification:navigate', sessionId: 's1', scope: '1' });
  });
  await expect(page).toHaveURL(/\/session\/s1$/);
  expect(errors).toEqual([]);
  console.log('Browser settings, notifications, persistent unread indicators, previews, stable title and click routing passed.');
  for (const platform of ['darwin', 'win32', 'linux']) {
    const nativeContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await nativeContext.addInitScript(platform => {
      delete Object.getPrototypeOf(navigator).serviceWorker;
      localStorage.setItem('userLanguage', 'zh-CN');
      window.__notifications = [];
      window.__badge = 0;
      window.__tasks = new Set();
      window.__settingsOpened = 0;
      window.__preferences = { enabled: false, sound: true, preview: true, badge: true };
      window.pilotdeckDesktop = {
        platform, getAppearance: () => ({ language: 'zh-CN', themeMode: 'light' }), setAppearance: async () => {},
        getNotificationStatus: async () => ({ supported: true, permission: 'unknown', preferences: window.__preferences }),
        setNotificationPreferences: async value => { window.__preferences = value; return value; },
        showNotification: async value => { window.__notifications.push(value); return true; },
        setNotificationScope: async () => {},
        recordTaskReminder: async value => { window.__tasks.add(JSON.stringify([value.data.scope, value.data.sessionId, value.data.taskId || value.id])); window.__badge = window.__preferences.badge ? window.__tasks.size : 0; return true; },
        openNotificationSettings: async () => { window.__settingsOpened++; return true; },
        onNotificationNavigate: callback => { window.__navigateNotification = data => { window.__badge = 0; window.__tasks.clear(); callback(data); }; return () => {}; },
      };
    }, platform);
    const nativePage = await nativeContext.newPage();
    let nativeSocket;
    await nativePage.route('**/api/**', mockApi);
    await nativePage.routeWebSocket('**/ws**', ws => { nativeSocket = ws; ws.onMessage(raw => {
      if (JSON.parse(raw).type === 'get-session-activity') ws.send(JSON.stringify({ type: 'session-activity-snapshot', scope: '1', activities: [] }));
    }); });
    await nativePage.goto(`${origin}/settings/general`);
    const nativeCard = nativePage.getByRole('article', { name: '通知', exact: true });
    await expect(nativeCard).toBeVisible();
    await nativeCard.getByRole('button', { name: '前往系统设置', exact: true }).click();
    await expect.poll(() => nativePage.evaluate(() => window.__settingsOpened)).toBe(1);
    await nativeCard.getByRole('switch', { name: '启用系统通知', exact: true }).click();
    await expect(nativeCard.getByRole('switch', { name: '启用系统通知', exact: true })).toHaveAttribute('aria-checked', 'true');
    await nativeCard.getByRole('switch', { name: '通知提示音', exact: true }).click();
    await expect(nativeCard.getByRole('switch', { name: '通知提示音', exact: true })).toHaveAttribute('aria-checked', 'false');
    nativeSocket.send(JSON.stringify({ type: 'session-notification', notification }));
    await expect.poll(() => nativePage.evaluate(() => window.__notifications.length)).toBe(1);
    expect(await nativePage.evaluate(() => window.__notifications[0].silent)).toBe(true);
    await expect.poll(() => nativePage.evaluate(() => window.__badge)).toBe(1);
    await nativePage.evaluate(() => window.__navigateNotification({ sessionId: 's1', scope: '1' }));
    await expect(nativePage).toHaveURL(/\/session\/s1$/);
    await nativeContext.close();
  }
  console.log('macOS, Windows and Linux bridge settings, sound, badge and click-routing checks passed without Service Worker support.');
} catch (error) {
  console.error('Page errors:', errors, consoleErrors.slice(-10));
  await page.screenshot({ path: `${artifacts}/failure.png`, fullPage: true }).catch(() => {});
  throw error;
} finally { await browser.close(); }
