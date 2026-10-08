import { test, expect } from '@playwright/test';
const A = { mode: 'model', provider: 'alpha', model: 'first' };
const B = { mode: 'model', provider: 'zeta', model: 'configured' };
const items = [A, B].map((x) => ({ id: `${x.provider}/${x.model}`, provider: x.provider, model: x.model, displayName: x.model, available: true, capabilities: {} }));
const catalog = { items: [{ id: 'router/auto', provider: 'router', model: 'auto', displayName: 'Auto', available: true, capabilities: {} }, ...items], defaultSelection: B, router: { autoAvailable: true } };
async function setup(page, { holdCatalog = false, unavailable = false, submittedSession = 'web:created' } = {}) {
  const saved = new Map();
  const submitted = [];
  const modelRequests = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let result = {};
    if (url.pathname === '/api/models' || url.pathname === '/api/sessions/model') modelRequests.push({ path: url.pathname, query: url.search, method: request.method() });
    if (url.pathname === '/api/models') {
      if (holdCatalog) await gate;
      result = unavailable ? { ...catalog, items: catalog.items.filter((x) => x.id !== 'zeta/configured') } : catalog;
    } else if (url.pathname === '/api/sessions/model') {
      if (request.method() === 'PUT') {
        const data = request.postDataJSON(); saved.set(data.sessionKey, data.selection);
      }
      result = { saved: saved.get(url.searchParams.get('sessionKey')), effective: A };
    } else if (url.pathname === '/api/test-submit') {
      const data = request.postDataJSON(); submitted.push(data);
      saved.set(submittedSession, data.options.modelSelection);
      result = { sessionId: submittedSession };
    }
    await route.fulfill({ json: result });
  });
  await page.goto('/e2e/fixtures/model-selection.html');
  return { saved, submitted, release, modelRequests };
}
const choice = async (page) => JSON.parse(await page.getByTestId('selection').textContent());

test('general and project defaults match configuration and sending is blocked while loading', async ({ page }) => {
  const { release, submitted } = await setup(page, { holdCatalog: true });
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  release();
  await expect.poll(() => choice(page)).toEqual(B);
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await expect.poll(() => choice(page)).toEqual(B);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0].options.modelSelection).toEqual(B);
  await expect.poll(() => choice(page)).toEqual(B);
});

test('manual selection survives sending, completion and reload', async ({ page }) => {
  const { submitted, modelRequests } = await setup(page);
  await expect.poll(() => choice(page)).toEqual(B);
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('button', { name: 'configured', exact: true }).click();
  await page.getByRole('button', { name: 'first', exact: true }).click();
  await expect.poll(() => choice(page)).toEqual(A);
  expect(modelRequests).toEqual([{ path: '/api/models', query: '?includeAuto=true', method: 'GET' }]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0].options.modelSelection).toEqual(A);
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect.poll(() => choice(page)).toEqual(A);
  await page.goto('/e2e/fixtures/model-selection.html?session=web:created');
  await expect.poll(() => choice(page)).toEqual(A);
});

test('explicit Auto stays selected without a composer execution banner', async ({ page }) => {
  const { submitted } = await setup(page);
  await expect.poll(() => choice(page)).toEqual(B);
  await page.getByRole('button', { name: 'configured', exact: true }).click();
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0].options.modelSelection).toEqual({ mode: 'auto' });
  await expect(page.getByText('Running:', { exact: false })).toHaveCount(0);
  await expect.poll(() => choice(page)).toEqual({ mode: 'auto' });
});

test('unavailable configured models block sending and the picker still allows recovery', async ({ page }) => {
  await setup(page, { unavailable: true });
  await expect.poll(() => choice(page)).toEqual(B);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'configured', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('zeta/configured');
  await page.getByRole('button', { name: 'first', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

test('new conversations and projects inherit the last accepted send, while unsent choices stay local', async ({ page }) => {
  const { submitted, modelRequests } = await setup(page);
  await expect.poll(() => choice(page)).toEqual(B);
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('button', { name: 'configured', exact: true }).click();
  await page.getByRole('button', { name: 'first', exact: true }).click();
  await expect.poll(() => choice(page)).toEqual(A);
  expect(modelRequests).toEqual([{ path: '/api/models', query: '?includeAuto=true', method: 'GET' }]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => submitted.length).toBe(1);
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await page.getByRole('button', { name: 'first', exact: true }).click();
  await page.getByRole('button', { name: 'configured', exact: true }).click();
  await expect.poll(() => choice(page)).toEqual(B);
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await expect.poll(() => choice(page)).toEqual(A);
  expect(modelRequests.filter(request => request.path === '/api/models')).toHaveLength(1);
});

for (const ready of [false, true]) test(`settings/help commands work with model ready=${ready}, via click and keyboard`, async ({ page }) => {
  const executed = [];
  await page.route('**/api/**', async (route) => {
    const isExecute = new URL(route.request().url()).pathname === '/api/commands/execute';
    const name = isExecute ? route.request().postDataJSON().commandName : '';
    if (isExecute) executed.push(name);
    await route.fulfill({ json: isExecute
      ? { type: 'builtin', action: name.slice(1), data: { content: 'Fixture help text' } }
      : { pinned: [], custom: [], builtIn: ['/config', '/help'].map((name) => ({ name, namespace: 'builtin', type: 'builtin', metadata: { type: 'builtin' } })) } });
  });
  await page.goto(`/e2e/fixtures/model-selection.html?commands=1&ready=${ready}`);
  await expect(page.getByTestId('commands-loaded')).toHaveText('2');
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  // A space completes the command token and closes the suggestion menu.
  await input.fill('/config ');
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => executed).toEqual(['/config']);
  await expect(page.getByTestId('settings-opened')).toHaveText('1');
  await input.fill('/help ');
  await input.press('Enter');
  await expect(page.getByTestId('command-messages')).toContainText('Fixture help text');
  expect(executed).toEqual(['/config', '/help']);
  await expect(page.getByTestId('model-requests')).toHaveText('0');
  if (!ready) {
    await input.fill('ordinary model request');
    await expect(send).toBeDisabled();
    await input.press('Enter');
    await input.fill('/unknown ');
    await expect(send).toBeDisabled();
    await input.press('Enter');
    await expect(page.getByTestId('model-requests')).toHaveText('0');
  }
});


test('accepted model choices synchronize across tabs while existing sessions retain their model', async ({ page, context }) => {
  await setup(page);
  await expect.poll(() => choice(page)).toEqual(B);
  const other = await context.newPage();
  await setup(other, { submittedSession: 'web:other' });
  await expect.poll(() => choice(other)).toEqual(B);
  await page.getByRole('button', { name: 'configured', exact: true }).click();
  await page.getByRole('button', { name: 'first', exact: true }).click();
  await expect.poll(() => choice(page)).toEqual(A);
  await expect.poll(() => choice(other)).toEqual(B);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => choice(other)).toEqual(A);
  await other.getByRole('button', { name: 'first', exact: true }).click();
  await other.getByRole('button', { name: 'Auto', exact: true }).click();
  await expect.poll(() => choice(page)).toEqual(A);
  await other.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('composer-model-last-sent') || 'null'))).toEqual({ mode: 'auto' });
  await expect.poll(() => choice(page)).toEqual(A);
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await expect.poll(() => choice(page)).toEqual({ mode: 'auto' });
  await page.reload();
  await expect.poll(() => choice(page)).toEqual({ mode: 'auto' });
});

test('response model appears before time only with the response hover actions', async ({ page }) => {
  const { submitted } = await setup(page);
  await expect.poll(() => choice(page)).toEqual(B);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => submitted.length).toBe(1);
  const response = page.getByTestId('response-fixture');
  const actions = response.getByTestId('assistant-message-actions');
  const label = actions.getByTestId('assistant-message-model');
  await expect(label).toHaveText('configured');
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS('opacity', '0');
  await response.hover();
  await expect(actions).toHaveCSS('opacity', '1');
  expect(await actions.evaluate((el) => el.firstElementChild.dataset.testid)).toBe('assistant-message-model');
  await expect(label).not.toHaveAttribute('title');
  await expect(actions).not.toContainText('zeta/');
  await page.getByRole('button', { name: 'configured', exact: true }).click();
  await page.getByRole('button', { name: 'first', exact: true }).click();
  await expect.poll(() => choice(page)).toEqual(A);
  await expect(label).toHaveText('configured');
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS('opacity', '0');
});

for (const preset of ['mint', 'blue']) {
  test(`the ${preset} model menu keeps white surfaces and follows the active accent`, async ({ page }) => {
    await setup(page);
    await expect.poll(() => choice(page), { timeout: 15000 }).toEqual(B);
    await page.evaluate(async preset => {
      const { applyLightAppearance } = await import('/src/lib/appearanceRuntime.ts');
      const { normalizeLightAppearance } = await import('/src/lib/lightAppearance.ts');
      applyLightAppearance(normalizeLightAppearance({ preset }), false);
    }, preset);
    await page.getByRole('button', { name: 'configured', exact: true }).click();
    const menu = page.locator('.pd-composer-model-menu');
    await expect(menu).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    const border = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pd-accent-border').trim());
    const expected = `rgb(${[1,3,5].map(index => parseInt(border.slice(index,index+2),16)).join(', ')})`;
    await expect(menu).toHaveCSS('border-top-color', expected);
    const search = menu.getByRole('searchbox');
    await search.focus();
    await expect(search).toHaveCSS('border-top-color', expected);
    const accents = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ['--pd-accent-strong', '--pd-accent'].map(name => {
        const hex = style.getPropertyValue(name).trim();
        return `rgb(${[1,3,5].map(index => parseInt(hex.slice(index,index+2),16)).join(', ')})`;
      });
    });
    const icons = page.getByTestId('palette-file-icons').locator('svg');
    await expect(icons.nth(0)).toHaveCSS('stroke', accents[0]);
    await expect(icons.nth(1)).toHaveCSS('color', accents[1]);
    await page.screenshot({ path: new URL(`../../artifacts/appearance-navigation/composer-${preset}.png`, import.meta.url).pathname });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });
}
