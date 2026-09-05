import { test, expect } from '@playwright/test';

const conversation = (page) => page.locator('[data-chat-search-surface]');
const top = (locator) => locator.evaluate((node) => node.scrollTop);
const pendingText = '[data-chat-search-render-pending="true"]';
const history = (count) => Array.from({ length: count }, (_, index) => ({
  id: `history-${index}`, type: index % 2 ? 'assistant' : 'user',
  content: `Historical message ${index}.\n\nAnother paragraph for reading.`,
}));
async function search(page, viewport, query) {
  await viewport.click({ position: { x: 20, y: 100 } });
  await page.keyboard.press('Meta+f');
  await page.getByRole('searchbox').fill(query);
}

for (const scenario of [
  { name: 'a phrase spanning text and a link', content: 'Visit https://example.com/unique-guide now.', query: 'Visit https://example.com/unique-guide', link: 'https://example.com/unique-guide', count: 30 },
  { name: 'a hidden Markdown URL', content: 'Read [Guide](https://example.com/unique-reference).', query: 'unique-reference', link: 'Guide', count: 30 },
  { name: 'a virtualized distant result without a highlight', content: 'Read [Guide](https://example.com/unique-reference).', query: 'unique-reference', link: 'Guide', count: 200 },
]) {
  test(`search locates ${scenario.name}`, async ({ page }) => {
    await page.goto('/e2e/fixtures/streaming-lifecycle.html?transcript');
    await page.evaluate(({ messages, content }) => window.streamLifecycle.set({ working: false, messages: [
      ...messages, { id: 'target', type: 'assistant', content },
    ] }), { messages: history(scenario.count), content: scenario.content });
    await search(page, conversation(page), scenario.query);
    await expect(page.getByRole('link', { name: scenario.link, exact: true })).toBeInViewport();
    await expect(page.locator('mark[aria-current="true"]')).toHaveCount(0);
    await conversation(page).hover({ position: { x: 20, y: 100 } });
    await page.mouse.wheel(0, -160);
    await expect.poll(() => conversation(page).evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeGreaterThan(50);
    const reading = await top(conversation(page));
    await page.evaluate(() => window.streamLifecycle.set({ messages: [
      ...window.streamLifecycle.messages, { id: 'later', type: 'assistant', content: 'Another response.\n\n'.repeat(20) },
    ] }));
    await page.waitForTimeout(250);
    expect(Math.abs(await top(conversation(page)) - reading)).toBeLessThan(2);
  });
}

for (const scenario of [
  { name: 'while the stream remains open', streaming: true, cancel: false },
  { name: 'after the backend completes', streaming: false, cancel: false },
  { name: 'with user cancellation', streaming: false, cancel: true },
  { name: 'before its first animation frame', streaming: false, cancel: false, empty: true },
]) {
  test(`search fallback waits for the rendered tail ${scenario.name}`, async ({ page }) => {
    // Advance animation frames explicitly so completion cannot race the assertion.
    await page.clock.install({ time: new Date('2026-09-05T00:00:00Z') });
    await page.goto('/e2e/fixtures/streaming-lifecycle.html?transcript');
    await page.evaluate((empty) => window.streamLifecycle.set({ messages: [
      { id: 'question', type: 'user', content: 'Read a long response' },
      { id: 'answer', type: 'assistant', content: empty ? '' : 'Starting.', isStreaming: true },
    ] }), Boolean(scenario.empty));
    await search(page, conversation(page), 'unique-reference');
    await page.clock.pauseAt(new Date('2026-09-05T00:01:00Z'));
    await page.evaluate((streaming) => window.streamLifecycle.set({ working: streaming, messages: [
      { id: 'question', type: 'user', content: 'Read a long response' },
      { id: 'answer', type: 'assistant', content: 'A paragraph to read.\n\n'.repeat(200) + '[Guide](https://example.com/unique-reference)', isStreaming: streaming },
    ] }), scenario.streaming);
    await expect(conversation(page).locator(pendingText)).toHaveCount(1);
    await page.clock.runFor(32);
    expect(await top(conversation(page))).toBe(0);
    await expect(conversation(page).locator(pendingText)).toHaveCount(1);
    if (scenario.cancel) {
      await conversation(page).dispatchEvent('wheel', { deltaY: -30 });
    }
    await page.clock.runFor(2500);
    await expect(conversation(page).locator(pendingText)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Guide', exact: true })).toHaveCount(1);
    await expect(page.locator('mark[aria-current="true"]')).toHaveCount(0);
    if (scenario.cancel) expect(await top(conversation(page))).toBe(0);
    else await expect.poll(() => top(conversation(page))).toBeGreaterThan(500);
  });
}

test('subagent search retains message-level fallback for hidden link URLs', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-lifecycle.html?child-direct');
  await page.evaluate(() => {
    window.streamLifecycle.text('Read this response.\n\n'.repeat(50) + '[Guide](https://example.com/unique-reference)');
    window.streamLifecycle.finish();
  });
  const viewport = page.locator('[data-stream-scroll-viewport]').first();
  await expect(page.getByRole('link', { name: 'Guide', exact: true })).toHaveCount(1);
  await viewport.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
  await search(page, viewport, 'unique-reference');
  await expect.poll(() => top(viewport)).toBeGreaterThan(200);
  await expect(page.locator('mark[aria-current="true"]')).toHaveCount(0);
});
