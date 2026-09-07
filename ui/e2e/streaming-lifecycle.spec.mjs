import { test, expect } from '@playwright/test';

const thoughts = (count) => Array.from({ length: count }, (_, i) => `Thought ${i}: compare the implementation and preserve the reading position.`).join('\n\n');
const top = (locator) => locator.evaluate((node) => node.scrollTop);
const gap = (locator) => locator.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
const outer = (page) => page.locator('[data-chat-search-surface]');
const childOuter = (page) => page.locator('[data-stream-scroll-viewport]').first();
const latest = (page) => page.getByRole('button', { name: 'Back to latest' });

// Exercise native wheel events on real nested overflow elements, not mocked scroll metrics.
test('short thinking ignores upward wheels, then global resume restores the inner tail', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  await page.evaluate(() => window.streamFixture.think('A short thought.'));
  const inner = page.getByRole('region', { name: 'Live thinking content' });
  await expect(inner).toContainText('A short thought.');
  expect(await gap(outer(page))).toBe(0);
  expect(await gap(inner)).toBe(0);
  await inner.hover();
  await page.mouse.wheel(0, -30);
  await expect(latest(page)).toHaveCount(0);
  await page.evaluate((text) => window.streamFixture.think(text), thoughts(50));
  await expect(inner).toContainText('Thought 49');
  await expect.poll(() => gap(inner)).toBeLessThan(3);
  await inner.hover();
  await page.mouse.wheel(0, -80);
  await expect.poll(() => gap(inner)).toBeGreaterThan(40);
  await expect(latest(page)).toBeVisible();
  expect(await gap(outer(page))).toBe(0);
  const reading = await top(inner);
  await page.evaluate((text) => window.streamFixture.think(text), thoughts(70));
  await expect(inner).toContainText('Thought 69');
  expect(Math.abs(await top(inner) - reading)).toBeLessThan(2);
  await latest(page).click();
  await expect.poll(() => gap(inner)).toBeLessThan(3);
  await page.evaluate((text) => window.streamFixture.think(text), thoughts(90));
  await expect(inner).toContainText('Thought 89');
  await expect.poll(() => gap(inner)).toBeLessThan(3);
  await expect(latest(page)).toHaveCount(0);
});

test('upward wheels over short thinking yield to the scrollable conversation', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-scroll.html');
  await page.evaluate(() => window.streamFixture.think('A short thought.'));
  const inner = page.getByRole('region', { name: 'Live thinking content' });
  await expect(inner).toContainText('A short thought.');
  await expect.poll(() => gap(outer(page))).toBeLessThan(3);
  await inner.hover();
  await page.mouse.wheel(0, -70);
  await expect.poll(() => gap(outer(page))).toBeGreaterThan(30);
  await expect(latest(page)).toBeVisible();
  const reading = await top(outer(page));
  await page.evaluate(() => window.streamFixture.think('A short thought. Now compare the result.'));
  await expect(inner).toContainText('Now compare the result.');
  expect(Math.abs(await top(outer(page)) - reading)).toBeLessThan(2);
});

for (const cancel of [false, true]) {
  test(`stream search waits for the visible match${cancel ? ' and respects cancellation' : ''}`, async ({ page }) => {
    await page.goto('/e2e/fixtures/streaming-lifecycle.html?transcript');
    await page.evaluate(() => window.streamLifecycle.set({ messages: [
      { id: 'question', type: 'user', content: 'Read a long response' },
      { id: 'answer', type: 'assistant', content: 'Starting.', isStreaming: true },
    ] }));
    await outer(page).click({ position: { x: 20, y: 100 } });
    await page.keyboard.press('Meta+f');
    await page.getByRole('searchbox').fill('TAIL_NEEDLE');
    await page.evaluate(() => window.streamLifecycle.set({ messages: [
      { id: 'question', type: 'user', content: 'Read a long response' },
      { id: 'answer', type: 'assistant', content: 'A paragraph to read.\n\n'.repeat(240) + 'TAIL_NEEDLE', isStreaming: true },
    ] }));
    await expect(page.locator('mark[aria-current="true"]')).toHaveCount(0);
    if (cancel) {
      await outer(page).hover({ position: { x: 20, y: 100 } });
      await page.mouse.wheel(0, -30);
    }
    await expect(page.locator('mark[aria-current="true"]')).toHaveText('TAIL_NEEDLE');
    if (cancel) expect(await top(outer(page))).toBe(0);
    else {
      await expect.poll(() => top(outer(page))).toBeGreaterThan(500);
      await expect(page.locator('mark[aria-current="true"]')).toBeInViewport();
    }
  });
}

test('historical sessions open at the bottom with auto follow disabled and preserve revisits', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-lifecycle.html?auto=false');
  await expect(page.getByText('Session a message 239.', { exact: false })).toBeVisible();
  await expect.poll(() => gap(outer(page))).toBeLessThan(3);
  const anchor = await outer(page).evaluate((node) => {
    const edge = node.getBoundingClientRect().top;
    const row = [...node.querySelectorAll('[data-message-key]')].find((item) => item.getBoundingClientRect().bottom > edge);
    return { key: row.dataset.messageKey, offset: row.getBoundingClientRect().top - edge };
  });
  await page.evaluate(() => window.streamLifecycle.append(10));
  await expect.poll(() => gap(outer(page))).toBeGreaterThan(100);
  await expect.poll(() => outer(page).evaluate((node, key) => {
    const row = [...node.querySelectorAll('[data-message-key]')].find((item) => item.dataset.messageKey === key);
    return row ? row.getBoundingClientRect().top - node.getBoundingClientRect().top : -100000;
  }, anchor.key)).toBeCloseTo(anchor.offset, 0);
  await outer(page).hover({ position: { x: 20, y: 300 } });
  await page.mouse.wheel(0, -150);
  await expect(latest(page)).toBeVisible();
  const reading = await outer(page).evaluate((node) => {
    const edge = node.getBoundingClientRect().top;
    const row = [...node.querySelectorAll('[data-message-key]')].find((item) => item.getBoundingClientRect().bottom > edge);
    return { key: row.dataset.messageKey, offset: row.getBoundingClientRect().top - edge };
  });
  await page.evaluate(() => window.streamLifecycle.setSession(1));
  await expect.poll(() => gap(outer(page))).toBeLessThan(3);
  await page.evaluate(() => window.streamLifecycle.setSession(0));
  await expect.poll(() => outer(page).evaluate((node, key) => {
    const row = [...node.querySelectorAll('[data-message-key]')].find((item) => item.dataset.messageKey === key);
    return row ? row.getBoundingClientRect().top - node.getBoundingClientRect().top : -100000;
  }, reading.key)).toBeCloseTo(reading.offset, 0);
});

for (const paused of [false, true]) {
  test(`subagent drains completion text while ${paused ? 'preserving the reader' : 'following the bottom'}`, async ({ page }) => {
    await page.goto('/e2e/fixtures/streaming-lifecycle.html?child-direct');
    await page.evaluate(() => window.streamLifecycle.text('Initial answer.\n\n'.repeat(60)));
    await expect.poll(() => gap(childOuter(page))).toBeLessThan(3);
    await expect.poll(() => top(childOuter(page))).toBeGreaterThan(200);
    if (paused) {
      await childOuter(page).hover({ position: { x: 20, y: 200 } });
      await page.mouse.wheel(0, -100);
      await expect(latest(page)).toBeVisible();
    }
    const reading = await top(childOuter(page));
    await page.evaluate(() => { window.streamLifecycle.text('Remaining text.\n\n'.repeat(100) + 'DRAIN_FINISHED'); window.streamLifecycle.finish(); });
    await expect(page.getByText('DRAIN_FINISHED', { exact: false })).toBeVisible();
    if (paused) expect(Math.abs(await top(childOuter(page)) - reading)).toBeLessThan(2);
    else await expect.poll(() => gap(childOuter(page))).toBeLessThan(3);
  });
}

test('completion snapshot refresh preserves the mounted thinking viewport and its reading state', async ({ page }) => {
  const thought = thoughts(60);
  const base = { sessionId: 's::sub::child', provider: 'pilotdeck', timestamp: '2026-09-05T00:00:00Z', role: 'assistant' };
  const oldSnapshot = [{ ...base, id: 'old', kind: 'text', content: 'An older persisted step.' }];
  let finishFetch;
  let requests = 0;
  await page.route('**/api/sessions/s/subagent/child/messages', async (route) => {
    requests += 1;
    if (requests === 1) return route.fulfill({ json: { messages: oldSnapshot } });
    await new Promise((resolve) => { finishFetch = resolve; });
    await route.fulfill({ json: { messages: [...oldSnapshot, { ...base, id: 'snapshot-thought', kind: 'thinking', role: undefined, content: thought }] } });
  });
  await page.goto('/e2e/fixtures/streaming-lifecycle.html?child');
  await expect(page.getByText('An older persisted step.')).toBeVisible();
  await page.evaluate((text) => window.streamLifecycle.think(text), thought);
  const inner = page.getByRole('region', { name: 'Live thinking content' });
  await expect(inner).toContainText('Thought 59');
  await expect.poll(() => gap(inner)).toBeLessThan(3);
  await inner.hover();
  await page.mouse.wheel(0, -100);
  await expect.poll(() => gap(inner)).toBeGreaterThan(50);
  const reading = await top(inner);
  await inner.evaluate((node) => { window.originalThinkingViewport = node; });
  await page.evaluate(() => window.streamLifecycle.finish());
  await expect.poll(() => requests).toBe(2);
  await expect(inner).toBeVisible();
  expect(await inner.evaluate((node) => node === window.originalThinkingViewport)).toBe(true);
  finishFetch();
  await expect.poll(() => page.evaluate(() => window.streamLifecycle.detail.isLoading)).toBe(false);
  await expect(page.getByRole('button', { name: 'Thought process' })).toHaveAttribute('aria-expanded', 'true');
  expect(await inner.evaluate((node) => node === window.originalThinkingViewport)).toBe(true);
  expect(Math.abs(await top(inner) - reading)).toBeLessThan(2);
});
