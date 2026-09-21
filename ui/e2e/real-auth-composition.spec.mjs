import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

const baseUrl = process.env.REAL_COMPOSITION_URL;
const profile = process.env.REAL_COMPOSITION_PROFILE;

test.skip(!baseUrl || !profile, 'Set REAL_COMPOSITION_URL and REAL_COMPOSITION_PROFILE for an authenticated composition run.');

async function authenticate(page, request) {
  const credentials = { username: `evidence-${profile}`, password: 'browser-evidence-password' };
  const registration = await request.post('/api/auth/register', { data: credentials });
  const account = registration.ok()
    ? await registration.json()
    : await (await request.post('/api/auth/login', { data: credentials })).json();
  const token = account.token;
  expect(typeof token).toBe('string');
  await page.addInitScript((value) => localStorage.setItem('auth-token', value), token);
  return token;
}

async function restartRuntime(request, token) {
  const response = await request.post('/api/update/restart', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(202);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await expect.poll(async () => {
    try {
      return (await request.get('/api/modules/runtime', {
        headers: { authorization: `Bearer ${token}` },
      })).status() === 200;
    } catch { return false; }
  }, { timeout: 30_000 }).toBeTruthy();
}

function recordRequests(page, token) {
  const requests = [];
  page.on('request', (entry) => {
    const url = new URL(entry.url());
    if (url.pathname === '/api/modules/runtime' || url.pathname.startsWith('/api/config') || url.pathname.startsWith('/api/modules/knowledge/')) {
      requests.push({
        path: url.pathname,
        method: entry.method(),
        authenticated: entry.headers().authorization === `Bearer ${token}`,
        body: entry.postDataJSON?.() ?? null,
      });
    }
  });
  return requests;
}

test('authenticated StaffDeck profile persists settings and queries the real Knowledge runtime', async ({ page, request }, testInfo) => {
  test.skip(profile !== 'staffdeck', 'StaffDeck acceptance only.');
  const token = await authenticate(page, request);
  const requests = recordRequests(page, token);
  const originalBase = 'kb_preset_data_001';
  const alternateBase = 'kb_preset_sales_001';
  const originalSop = 'operator_approval';
  const alternateSop = 'operator_approval_alternate';
  let sopStatus;

  try {
    await page.goto('/settings/module/knowledge');
    const base = page.getByLabel('Default knowledge base');
    await expect(base).toHaveValue(originalBase);
    await base.fill(alternateBase);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByTestId('module-profile-setting-knowledge-defaultBaseId').getByRole('status')).toContainText('Saved and reloaded.');
    await page.reload();
    await expect(base).toHaveValue(alternateBase);

    await page.goto('/knowledge');
    await page.getByPlaceholder('Search the configured knowledge base').fill('客户拓展');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByText(/销售|sales/i).first()).toBeVisible();
    await page.getByRole('button', { name: 'Resolve citation', exact: true }).click();
    await expect(page.locator('pre').last()).toContainText('kchunk_preset_sales_001');
    await expect.poll(() => requests.some((entry) => entry.path === '/api/modules/knowledge/query')).toBeTruthy();

    await page.goto('/settings/module/sop');
    const workflow = page.getByLabel('Default workflow');
    await expect(workflow).toHaveValue(originalSop);
    await workflow.fill(alternateSop);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByTestId('module-profile-setting-sop-defaultSopId').getByRole('status')).toContainText('Saved and reloaded.');
    await restartRuntime(request, token);
    await page.goto('/settings/module/sop');
    await page.reload();
    await expect(workflow).toHaveValue(alternateSop);

    await page.goto('/');
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    const composer = page.locator('textarea').last();
    await composer.fill('Start the operator approval workflow.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const banner = page.locator('[data-chat-composer-slot] [data-testid="sop-wait-banner"]');
    await expect(banner).toContainText('This SOP is waiting for a handoff response.', { timeout: 20_000 });
    const statusResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/sop/status', { timeout: 20_000 });
    await banner.getByRole('button', { name: 'Refresh SOP status' }).click();
    sopStatus = await (await statusResponse).json();
    expect(sopStatus.status.state.selected_skill_id).toBe(alternateSop);
    const continuation = banner.getByLabel('SOP continuation message');
    await continuation.fill('operator approved');
    await banner.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('Continuation prepared. Send it to continue the SOP.')).toBeVisible();
    await expect(composer).toHaveValue(/operator approved/i);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Browser operator approval completed.')).toBeVisible({ timeout: 20_000 });
    await expect(banner).toBeHidden();
    expect(requests.every((entry) => entry.authenticated)).toBeTruthy();

    await page.screenshot({ path: testInfo.outputPath('staffdeck-real-knowledge-settings.png'), fullPage: true });
    await writeFile(testInfo.outputPath('staffdeck-real-knowledge-report.json'), JSON.stringify({ requests, sopStatus }, null, 2));
  } finally {
    await page.goto('/settings/module/knowledge');
    const base = page.getByLabel('Default knowledge base');
    await base.fill(originalBase);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.reload();
    await expect(base).toHaveValue(originalBase);

    await page.goto('/settings/module/sop');
    const workflow = page.getByLabel('Default workflow');
    await workflow.fill(originalSop);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await restartRuntime(request, token);
    await page.goto('/settings/module/sop');
    await page.reload();
    await expect(workflow).toHaveValue(originalSop);
  }
});

test('authenticated minimal profile keeps disabled module routes and requests inert', async ({ page, request }, testInfo) => {
  test.skip(profile !== 'minimal', 'Minimal-profile acceptance only.');
  const token = await authenticate(page, request);
  const requests = recordRequests(page, token);
  await page.goto('/knowledge');
  await expect(page.getByPlaceholder('Search the configured knowledge base')).toHaveCount(0);
  await page.goto('/sop');
  await expect(page.locator('section').getByRole('heading', { name: 'Workflow' })).toHaveCount(0);
  await page.goto('/settings/module/knowledge');
  await expect(page.getByLabel('Default knowledge base')).toHaveCount(0);
  expect(requests.filter((entry) => entry.path.startsWith('/api/modules/knowledge/'))).toHaveLength(0);
  expect(requests.every((entry) => entry.authenticated)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('minimal-disabled-routes.png'), fullPage: true });
  await writeFile(testInfo.outputPath('minimal-disabled-routes-report.json'), JSON.stringify({ requests }, null, 2));
});

test('authenticated replacement profile sends saved result limits to its replacement runtime', async ({ page, request }, testInfo) => {
  test.skip(profile !== 'replacement', 'Replacement-profile acceptance only.');
  const token = await authenticate(page, request);
  const requests = recordRequests(page, token);
  await page.goto('/settings/module/knowledge');
  const limit = page.getByLabel('Result limit');
  await limit.fill('3');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('module-profile-setting-knowledge-resultLimit').getByRole('status')).toContainText('Saved and reloaded.');
  await page.reload();
  await expect(limit).toHaveValue('3');
  await page.goto('/knowledge-search');
  await page.getByPlaceholder('Search the replacement knowledge service').fill('replacement proof');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('Replacement runtime verified this query through an independent module process.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resolve citation', exact: true }).click();
  await expect(page.locator('pre').last()).toContainText('replacement-knowledge-runtime');
  await expect.poll(() => requests.some((entry) => entry.path === '/api/modules/knowledge/query')).toBeTruthy();
  expect(requests.every((entry) => entry.authenticated)).toBeTruthy();

  const evidencePath = process.env.REPLACEMENT_KNOWLEDGE_EVIDENCE_PATH;
  expect(evidencePath).toBeTruthy();
  await expect.poll(async () => {
    const entries = (await readFile(evidencePath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return entries.find((entry) => entry.operation === 'query')?.input?.limit;
  }).toBe(3);
  await page.screenshot({ path: testInfo.outputPath('replacement-real-settings-query.png'), fullPage: true });
  await writeFile(testInfo.outputPath('replacement-real-report.json'), JSON.stringify({
    requests,
    replacementRuntimeEntries: (await readFile(evidencePath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  }, null, 2));
});
