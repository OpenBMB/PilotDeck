import { expect, test } from '@playwright/test';

const profile = process.env.FORMAL_ROUTE_PROFILE;

test.skip(!profile || !process.env.FORMAL_COMPOSITION_URL, 'Set FORMAL_ROUTE_PROFILE and FORMAL_COMPOSITION_URL for a formal route-matrix run.');

test(`formal ${profile} routes follow the generated composition`, async ({ page }, testInfo) => {
  await page.goto('/');
  const skills = page.getByRole('button', { name: 'Skills', exact: true });
  if (profile === 'native') {
    await page.goto('/skills');
    await expect(page.getByRole('heading', { name: /Skills/i })).toBeVisible();
  } else {
    await expect(skills).toHaveCount(0);
    await page.goto('/skills');
    await expect(page.getByRole('heading', { name: /Skills/i })).toHaveCount(0);
  }
  for (const [path, title] of [['/sop', 'Workflow'], ['/knowledge', 'Knowledge']]) {
    await page.goto(path);
    await expect(page.locator('section').getByRole('heading', { name: title })).toHaveCount(0);
  }
  await page.screenshot({ path: testInfo.outputPath(`${profile}-route-matrix.png`), fullPage: true });
});
