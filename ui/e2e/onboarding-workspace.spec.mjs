import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

for (const scenario of ['create', 'clone', 'retry completion', 'skip']) {
  test(`onboarding opens the selected workspace: ${scenario}`, async ({ page, context }) => {
    const project = { name: 'onboarding space-项目', displayName: 'New workspace', fullPath: '/fixture/new-workspace', sessions: [] };
    const general = { name: 'general', displayName: 'General conversation', fullPath: '/fixture/general', sessions: [] };
    let completed = false, created = false, creations = 0, completions = 0;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => localStorage.setItem('userLanguage', 'en'));
    await context.routeWebSocket('**/ws**', socket => socket.onMessage(() => {}));
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      let body = {}, status = 200;
      if (pathname === '/api/auth/status') body = { authDisabled: true };
      else if (pathname === '/api/user/onboarding-status') body = { hasCompletedOnboarding: completed };
      else if (pathname === '/api/user/complete-onboarding') {
        completions++;
        if (scenario === 'retry completion' && completions === 1) {
          status = 503; body = { error: 'Please retry completion' };
        } else completed = true;
      } else if (pathname === '/api/projects/create-workspace' || pathname === '/api/projects/clone-progress') {
        creations++; created = true;
        if (pathname.endsWith('clone-progress')) {
          expect(url.searchParams.get('path')).toBe('/fixture/new-workspace');
          expect(url.searchParams.get('githubUrl')).toBe('https://github.com/example/demo.git');
          await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'complete', project })}\n\n` });
          return;
        }
        expect(route.request().postDataJSON()).toMatchObject({ path: '/fixture/new-workspace', workspaceType: 'new' });
        body = { project };
      } else if (pathname === '/api/projects') body = created ? [general, project] : [general];
      else if (pathname === '/api/config/provider') body = { exists: false, provider: null };
      else if (pathname === '/api/config/models') body = { models: [{ id: 'fixture-model' }] };
      else if (pathname === '/api/config') body = { config: {}, raw: '', exists: false, success: true };
      else if (pathname === '/api/v1/providers') body = { providers: [{ id: 'ollama', displayName: 'Ollama', requiresApiKey: false }] };
      else if (pathname.includes('sessions')) body = { sessions: [], total: 0, hasMore: false };
      else if (pathname.includes('credentials')) body = { credentials: [] };
      else if (pathname.includes('providers') || pathname.includes('models')) body = { providers: [], models: [] };
      else if (pathname.includes('tasks')) body = { tasks: [] };
      else if (pathname.includes('skills') || pathname.includes('plugins')) body = { skills: [], plugins: [] };
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });

    // Replace a previous workspace selection when onboarding finishes.
    await page.goto('/p/general');
    await page.getByRole('button', { name: 'Start setup', exact: true }).click();
    await page.getByRole('button', { name: 'Ollama', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'fixture-model', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Create your workspace', exact: true })).toBeVisible();
    if (scenario === 'skip') {
      await page.getByRole('button', { name: 'Start chatting', exact: true }).click();
    } else {
      await page.getByRole('textbox', { name: /^Workspace / }).fill('/fixture/new-workspace');
      if (scenario === 'clone') await page.getByRole('textbox', { name: /^GitHub URL / }).fill('https://github.com/example/demo.git');
      await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
      if (scenario === 'retry completion') {
        await expect(page.getByText('Please retry completion', { exact: true })).toBeVisible();
        await expect(page).toHaveURL(/\/p\/general$/);
        await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
      }
    }
    await expect(page.locator('.app-shell')).toBeVisible();
    const selected = scenario === 'skip' ? general : project;
    await expect(page).toHaveURL(new RegExp(`/p/${encodeURIComponent(selected.name)}$`));
    await expect(page.locator('.workspace-title')).toContainText(selected.displayName);
    await expect(page.locator('.onboarding-shell')).toHaveCount(0);
    expect(creations).toBe(scenario === 'skip' ? 0 : 1);
    expect(completions).toBe(scenario === 'retry completion' ? 2 : 1);
    expect(errors).toEqual([]);
  });
}
