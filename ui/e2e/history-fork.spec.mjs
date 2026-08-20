import { expect, test } from '@playwright/test';

const PROJECT_PATH = process.env.PILOTDECK_E2E_PROJECT_PATH;
const CONTROL_URL = process.env.PILOTDECK_E2E_CONTROL_URL;

test.describe.configure({ mode: 'serial' });

test('live messages survive reload and remain isolated across sessions', async ({ page }) => {
  await openProjectChat(page);
  await send(page, 'first session marker');
  await expect(page.getByText('Fake response: first session marker', { exact: false })).toBeVisible();
  const firstSessionUrl = page.url();

  await newChat(page);
  const secondSessionUrl = page.url();
  expect(secondSessionUrl).not.toBe(firstSessionUrl);
  await send(page, 'second session marker');
  await expect(page.getByText('Fake response: second session marker', { exact: false })).toBeVisible();
  await expect(page.getByText('Fake response: first session marker', { exact: false })).toHaveCount(0);

  await page.goto(firstSessionUrl);
  await expect(page.getByText('Fake response: first session marker', { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Fake response: first session marker', { exact: false })).toBeVisible();
});

test('Stop aborts a turn and queued force-send submits the captured draft', async ({ page }) => {
  await openProjectChat(page);
  await send(page, '[delay] stop this request');
  await expect(page.getByText('Working on delayed request...', { exact: false })).toBeVisible();
  await page.getByTitle('Stop').click();
  await expect(page.getByTitle('Stop')).toHaveCount(0);

  await send(page, '[delay] replace this request');
  await expect(page.getByText('Working on delayed request...', { exact: false })).toBeVisible();
  const textarea = composer(page);
  await textarea.fill('queued follow-up marker');
  await submit(page).click();
  await expect(submit(page)).toHaveAttribute('title', /Queued/);
  await submit(page).click();
  await expect(page.getByText('Fake response: queued follow-up marker', { exact: false })).toBeVisible();
});

test('permission prompts resume after allow and deny decisions', async ({ page }) => {
  await openProjectChat(page);
  await page.getByTitle('Select permission mode').click();
  await page.getByRole('menuitemradio').filter({ hasText: 'Default Permissions' }).click();
  await send(page, '[permission] allow flow');
  await expect(page.getByText('Permission required', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByText('Permission flow completed', { exact: false })).toBeVisible();

  await newChat(page);
  await page.getByTitle('Select permission mode').click();
  await page.getByRole('menuitemradio').filter({ hasText: 'Default Permissions' }).click();
  await send(page, '[permission] deny flow');
  await expect(page.getByText('Permission required', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Deny' }).click();
  await expect(page.getByText('Permission flow completed', { exact: false })).toBeVisible();
});

test('the UI reconnects after a controlled Gateway restart', async ({ page, request }) => {
  await openProjectChat(page);
  await send(page, 'before gateway restart');
  await expect(page.getByText('Fake response: before gateway restart', { exact: false })).toBeVisible();

  const restarted = await request.post(`${CONTROL_URL}/restart-gateway`);
  expect(restarted.ok()).toBeTruthy();
  await send(page, 'gateway reconnect probe');
  await expect(page.getByText('PilotDeck gateway is unavailable.', { exact: false })).toBeVisible();
  await expect.poll(async () => {
    try {
      return await page.evaluate(async () => (await fetch('/api/projects')).ok);
    } catch {
      return false;
    }
  }, { timeout: 20_000, intervals: [500, 1_000, 2_000] }).toBe(true);
  await send(page, 'after gateway restart');
  await expect(page.getByText('Fake response: after gateway restart', { exact: false })).toBeVisible();
});

test('history fork carries the selected user entry in the controlled workspace', async ({ page, request }) => {
  await openProjectChat(page);
  await send(page, 'fork retained context');
  await expect(page.getByText('Fake response: fork retained context', { exact: false })).toBeVisible();
  await send(page, 'fork source marker');
  await expect(page.getByText('Fake response: fork source marker', { exact: false })).toBeVisible();
  const sessionId = sessionIdFromUrl(page.url());

  const messagesResponse = await request.get(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages?projectPath=${encodeURIComponent(PROJECT_PATH)}&limit=200`,
  );
  expect(messagesResponse.ok()).toBeTruthy();
  const payload = await messagesResponse.json();
  const userMessage = payload.messages.findLast(message => message.role === 'user' && message.entryId);
  expect(userMessage?.entryId).toBeTruthy();

  const forkResponse = await request.post(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {
    data: { projectPath: PROJECT_PATH, fromEntryId: userMessage.entryId },
  });
  expect(forkResponse.ok()).toBeTruthy();
  const fork = await forkResponse.json();
  expect(fork.newSessionId).toMatch(/^web[:-]s_/);
  expect(fork.carriedMessageCount).toBeGreaterThan(0);
  expect(fork.prefillText).toContain('fork source marker');
});

async function openProjectChat(page) {
  await page.goto('/');
  const project = page.getByText('e2e-workspace', { exact: true }).first();
  await expect(project).toBeVisible();
  await project.click();
  await newChat(page);
}

async function newChat(page) {
  const previous = page.url();
  const button = page.getByRole('button', { name: 'New Chat' }).last();
  await expect(button).toBeVisible();
  await button.click();
  await expect(composer(page)).toBeVisible();
  if (previous.includes('/c/')) {
    await expect.poll(() => page.url()).not.toBe(previous);
  }
}

async function send(page, text) {
  await composer(page).fill(text);
  await submit(page).click();
}

function composer(page) {
  return page.locator('textarea:visible').last();
}

function submit(page) {
  return page.locator('button[type="submit"]').last();
}

function sessionIdFromUrl(url) {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  const index = Math.max(segments.lastIndexOf('c'), segments.lastIndexOf('session'));
  if (index < 0 || !segments[index + 1]) throw new Error(`No session id in ${url}`);
  return decodeURIComponent(segments[index + 1]);
}
