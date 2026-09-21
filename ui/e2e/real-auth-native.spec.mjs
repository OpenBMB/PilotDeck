import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test.skip(!process.env.REAL_NATIVE_URL, 'Set REAL_NATIVE_URL for the local authenticated native-profile acceptance run.');

test('native Settings reads, saves, reloads, and authenticates runtime/config calls', async ({ page, request }, testInfo) => {
  const registration = await request.post('/api/auth/register', {
    data: { username: 'browser-evidence', password: 'browser-evidence-password' },
  });
  expect(registration.ok()).toBeTruthy();
  const account = await registration.json();
  const token = account.token;
  expect(typeof token).toBe('string');

  const protectedRequests = [];
  page.on('request', (entry) => {
    const url = new URL(entry.url());
    if (url.pathname === '/api/modules/runtime' || url.pathname.startsWith('/api/config')) {
      protectedRequests.push({ path: url.pathname, authorization: entry.headers().authorization ?? null });
    }
  });
  await page.addInitScript((value) => localStorage.setItem('auth-token', value), token);
  await page.goto('/settings/module/agent-route');
  const routing = page.getByRole('switch').first();
  await expect(routing).toBeVisible();
  const initial = await routing.getAttribute('aria-checked');
  await routing.click();
  await expect.poll(() => protectedRequests.some((item) => item.path === '/api/config')).toBeTruthy();
  await page.reload();
  await expect(routing).toHaveAttribute('aria-checked', initial === 'true' ? 'false' : 'true');
  await expect.poll(() => protectedRequests.some((item) => item.path === '/api/modules/runtime')).toBeTruthy();
  expect(protectedRequests.every((item) => item.authorization === `Bearer ${token}`)).toBeTruthy();

  await page.screenshot({ path: testInfo.outputPath('native-settings-jwt-save-reload.png'), fullPage: true });
  await writeFile(testInfo.outputPath('native-settings-jwt-report.json'), JSON.stringify({
    runtimeAndConfigRequests: protectedRequests.map(({ path, authorization }) => ({ path, authenticated: authorization === `Bearer ${token}` })),
    initialRoutingEnabled: initial,
    persistedRoutingEnabled: await routing.getAttribute('aria-checked'),
  }, null, 2));
});
