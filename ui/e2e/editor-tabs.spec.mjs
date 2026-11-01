import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ content: '// File content for editor layout regression.\n' }),
  }));
  await page.goto('/e2e/fixtures/editor-tabs.html');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
});

async function verifyLayout(page) {
  await expect.poll(() => page.getByRole('tablist').evaluate(list => {
    const viewport = list.getBoundingClientRect();
    const tab = list.querySelector('[aria-selected="true"]')?.parentElement.getBoundingClientRect();
    return Boolean(tab && tab.left >= viewport.left - 1 && tab.right <= viewport.right + 1);
  })).toBe(true);
  const viewport = await page.getByRole('tablist').boundingBox();
  const save = page.getByRole('button', { name: 'Save', exact: true });
  const toolbar = await save.locator('..').locator('..').boundingBox();
  expect(viewport.x + viewport.width).toBeLessThanOrEqual(toolbar.x + 1);
  expect(Math.abs(viewport.y - toolbar.y)).toBeLessThan(1);
  expect(await save.evaluate(button => {
    const rect = button.getBoundingClientRect();
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === button;
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('tabs shrink as files are opened and keep the toolbar separate', async ({ page }) => {
  const initialWidth = await page.getByRole('tab').first().evaluate(button => button.parentElement.getBoundingClientRect().width);
  await page.evaluate(() => window.editorTabsFixture.setCount(6));
  await expect(page.getByRole('tab')).toHaveCount(6);
  await verifyLayout(page);
  const widths = await page.getByRole('tab').evaluateAll(buttons => buttons.map(button => button.parentElement.getBoundingClientRect().width));
  expect(Math.max(...widths)).toBeLessThan(initialWidth - 20);
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(96);
  expect(await page.getByRole('tablist').evaluate(list => list.scrollWidth - list.clientWidth)).toBeLessThanOrEqual(1);
  await page.getByRole('tab').first().click();
  await expect(page.getByRole('button', { name: 'Preview HTML', exact: true })).toBeVisible();
  await verifyLayout(page);
  await page.screenshot({ path: test.info().outputPath('six-tabs.png') });
});

test('overflowing files stay reachable and active tabs survive resizing and closing', async ({ page }) => {
  await page.evaluate(() => window.editorTabsFixture.setCount(25));
  await expect(page.getByRole('tab')).toHaveCount(25);
  await verifyLayout(page);
  for (const width of [720, 390, 1000]) {
    await page.setViewportSize({ width, height: 700 });
    await verifyLayout(page);
  }
  const trigger = page.getByRole('button', { name: 'Open files', exact: true });
  await trigger.click();
  await expect(page.getByRole('menuitemradio')).toHaveCount(25);
  await page.getByRole('menuitemradio', { name: /index.html/ }).click();
  await expect(page.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab').first()).toBeFocused();
  await verifyLayout(page);
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio').first()).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
  await verifyLayout(page);
  await expect(page.getByRole('tab').last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab').first()).toBeFocused();
  await verifyLayout(page);
  await page.keyboard.press('End');
  await expect(page.getByRole('tab').last()).toBeFocused();
  await verifyLayout(page);
  await page.getByRole('tab', { selected: true }).locator('..').getByRole('button', { name: /^Close / }).click();
  await expect(page.getByRole('tab')).toHaveCount(24);
  await verifyLayout(page);
  await page.screenshot({ path: test.info().outputPath('overflow-tabs.png') });
});

test('legacy separate header also keeps tabs within its viewport', async ({ page }) => {
  await page.goto('/e2e/fixtures/editor-tabs.html?legacy=true');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await page.evaluate(() => window.editorTabsFixture.setCount(15));
  await expect(page.getByRole('tab')).toHaveCount(15);
  await expect(page.getByRole('tablist')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  const list = await page.getByRole('tablist').boundingBox();
  const toolbar = await page.getByRole('button', { name: 'Save', exact: true }).boundingBox();
  expect(toolbar.y).toBeGreaterThanOrEqual(list.y + list.height);
  await page.getByRole('button', { name: 'Open files', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open files', exact: true })).toBeFocused();
  await expect(page.getByRole('menu')).toHaveCount(0);
});
