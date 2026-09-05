import { test, expect } from '@playwright/test';

const lines = (count) => Array.from({ length: count }, (_, i) => `Thinking line ${i + 1}: inspect and compare the implementation.`).join('\n\n');
const viewport = (page) => page.locator('[data-chat-search-surface]');
const top = (locator) => locator.evaluate((node) => node.scrollTop);
const distance = (locator) => locator.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);

async function open(page) {
  await page.goto('/e2e/fixtures/streaming-scroll.html');
  await expect(page.getByText('Question 23', { exact: true })).toBeVisible();
  await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
}

test('small upward gestures win over text streaming and explicit resume follows again', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.streamFixture.text('Streaming response.\n\n'.repeat(60)));
  await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
  await viewport(page).hover({ position: { x: 20, y: 300 } });
  await page.mouse.wheel(0, -30);
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
  const readingTop = await top(viewport(page));
  await page.evaluate(() => window.streamFixture.text('Streaming response.\n\n'.repeat(100)));
  await expect.poll(() => distance(viewport(page))).toBeGreaterThan(40);
  await page.waitForTimeout(700);
  expect(Math.abs(await top(viewport(page)) - readingTop)).toBeLessThan(2);
  await page.getByRole('button', { name: 'Back to latest' }).click();
  await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
});

test('thinking retains its viewport, expansion and reading position through tools and completion', async ({ page }) => {
  await open(page);
  await page.evaluate((text) => window.streamFixture.think(text), lines(30));
  const thinking = page.getByRole('region', { name: 'Live thinking content' });
  await expect(thinking.getByText(/Thinking line 30/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Thinking...' })).toHaveCount(1);
  await thinking.hover();
  await page.mouse.wheel(0, -70);
  await expect.poll(() => distance(thinking)).toBeGreaterThan(30);
  const readingTop = await top(thinking);
  const outerTop = await top(viewport(page));
  await page.evaluate((text) => window.streamFixture.think(text), lines(45));
  await page.waitForTimeout(500);
  expect(Math.abs(await top(thinking) - readingTop)).toBeLessThan(2);
  await page.evaluate(() => window.streamFixture.tool());
  await expect(page.getByRole('button', { name: 'Thought process' })).toHaveAttribute('aria-expanded', 'true');
  expect(Math.abs(await top(thinking) - readingTop)).toBeLessThan(2);
  expect(Math.abs(await top(viewport(page)) - outerTop)).toBeLessThan(2);
  await page.evaluate(() => { window.streamFixture.finishTool(); window.streamFixture.text('Final answer.'); window.streamFixture.complete(); });
  await expect(thinking).toBeVisible();
  expect(Math.abs(await top(thinking) - readingTop)).toBeLessThan(2);
  await page.screenshot({ path: test.info().outputPath('thinking-reading-position.png') });
});

test('web fetch has one status in plan mode and empty results finish it; parallel calls remain distinct', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.streamFixture.setMode('plan'); window.streamFixture.tool(); });
  await expect(page.locator('.process-live-status')).toHaveCount(1);
  await expect(page.getByText('Fetching web content...', { exact: true })).toHaveCount(1);
  await page.evaluate(() => window.streamFixture.finishTool());
  await expect(page.getByText('Fetching web content...', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.streamFixture.tool('fetch-2'); window.streamFixture.tool('fetch-3'); window.streamFixture.finishTool('fetch-2'); });
  await expect(page.getByText('Fetching web content...', { exact: true })).toHaveCount(1);
  await page.evaluate(() => window.streamFixture.finishTool('fetch-3'));
  await expect(page.getByText('Fetching web content...', { exact: true })).toHaveCount(0);
});

test('stream updates do not repeatedly recenter an existing search match', async ({ page }) => {
  await open(page);
  await viewport(page).click({ position: { x: 20, y: 300 } });
  await page.keyboard.press('Meta+f');
  await page.getByRole('searchbox').fill('needle 10');
  await expect(page.locator('mark.chat-history-search-highlight-active')).toBeVisible();
  await viewport(page).hover({ position: { x: 20, y: 300 } });
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(150);
  const readingTop = await top(viewport(page));
  await page.evaluate(() => window.streamFixture.text('New streamed content '.repeat(150)));
  await page.waitForTimeout(700);
  expect(Math.abs(await top(viewport(page)) - readingTop)).toBeLessThan(2);
});

test('prepending virtualized history while streaming preserves the visible message anchor', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.streamFixture.prepend(200));
  await expect(page.locator('[data-virtualized-messages="true"]')).toHaveCount(1);
  await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
  await viewport(page).hover({ position: { x: 20, y: 300 } });
  await page.mouse.wheel(0, -300);
  await expect(page.getByRole('button', { name: 'Back to latest' })).toBeVisible();
  await page.waitForTimeout(200);
  const anchor = await viewport(page).evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const row = [...node.querySelectorAll('[data-message-key]')].find((item) => item.getBoundingClientRect().bottom > rect.top);
    return { key: row.dataset.messageKey, y: row.getBoundingClientRect().top };
  });
  await page.evaluate(() => { window.streamFixture.prepend(60); window.streamFixture.text('New response.\n\n'.repeat(50)); });
  await expect.poll(() => viewport(page).evaluate((node, key) => {
    const anchorRow = [...node.querySelectorAll('[data-message-key]')].find((item) => item.dataset.messageKey === key);
    return anchorRow ? anchorRow.getBoundingClientRect().top : -10000;
  }, anchor.key)).toBeCloseTo(anchor.y, 0);
  await page.waitForTimeout(700);
  const finalY = await viewport(page).evaluate((node, key) => [...node.querySelectorAll('[data-message-key]')]
    .find((item) => item.dataset.messageKey === key)?.getBoundingClientRect().top, anchor.key);
  expect(Math.abs(finalY - anchor.y)).toBeLessThan(2);
});
