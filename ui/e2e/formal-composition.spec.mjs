import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({}, testInfo) => {
  test.skip(!process.env.FORMAL_COMPOSITION_URL, 'Set FORMAL_COMPOSITION_URL to run against a formal Web+StaffDeck deployment.');
  const replacementOnly = process.env.FORMAL_REPLACEMENT === '1';
  test.skip(replacementOnly && !testInfo.title.includes('replacement Knowledge'), 'Replacement profile only runs its conformance workflow.');
  test.skip(!replacementOnly && testInfo.title.includes('replacement Knowledge'), 'Replacement conformance requires FORMAL_REPLACEMENT=1.');
  testInfo.annotations.push({ type: 'composition-source', description: 'formal AppShellV2' });
});

test('formal Knowledge query and citation resolution', async ({ page }, testInfo) => {
  await page.goto('/knowledge');
  await expect(page.locator('section').getByRole('heading', { name: 'Knowledge' })).toBeVisible();
  await page.getByPlaceholder('Search the configured knowledge base').fill('Rollback verification');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('p').filter({ hasText: 'Rollback verification requires an approved operator and a persisted recovery plan.' }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Resolve citation' }).click();
  await expect(page.locator('pre').last()).toContainText('kchunk_');
  await page.screenshot({ path: testInfo.outputPath('knowledge-real-query-citation.png'), fullPage: true });
});

test('formal SOP lifecycle resumes through the real StaffDeck runtime', async ({ page }, testInfo) => {
  await page.goto('/p/general');
  const composer = page.locator('textarea').last();
  await composer.fill('Start the operator approval workflow.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const banner = page.locator('[data-chat-composer-slot] [data-testid="sop-wait-banner"]');
  await expect(banner).toContainText('This SOP is waiting for a handoff response.', { timeout: 20_000 });
  await expect(page).toHaveURL(/\/session\//);
  const continuation = banner.getByLabel('SOP continuation message');
  await continuation.fill('operator approved');
  await expect(continuation).toHaveValue('operator approved');
  await banner.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('Continuation prepared. Send it to continue the SOP.')).toBeVisible();
  await expect(composer).toHaveValue(/operator approved/i);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Browser operator approval completed.')).toBeVisible({ timeout: 20_000 });
  await expect(banner).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('sop-real-lifecycle.png'), fullPage: true });
});

test('formal SOP and Skills routes follow the active composition', async ({ page }) => {
  await page.goto('/sop');
  await expect(page.locator('section').getByRole('heading', { name: 'Workflow' })).toBeVisible();
  await page.goto('/skills');
  await expect(page.getByRole('heading', { name: /Skills/i })).toBeVisible();
});

test('formal replacement Knowledge switches frontend and backend implementation', async ({ page }, testInfo) => {
  await page.goto('/knowledge-search');
  await expect(page.locator('section').getByRole('heading', { name: 'Knowledge search' })).toBeVisible();
  await page.getByPlaceholder('Search the replacement knowledge service').fill('replacement proof');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('Replacement runtime verified this query through an independent module process.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resolve citation' }).click();
  await expect(page.locator('pre').last()).toContainText('replacement-knowledge-runtime');
  await page.screenshot({ path: testInfo.outputPath('replacement-knowledge-conformance.png'), fullPage: true });
});
