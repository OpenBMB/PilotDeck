import { test, expect } from './fixtures/scroll-test.mjs';

const viewport = page => page.locator('[data-chat-search-surface]');
const position = locator => locator.evaluate(node => node.scrollTop);
const remaining = locator => locator.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);

for (const history of [2, 200]) for (const running of [false, true]) {
  test(`keyboard navigation owns the ${running ? 'live' : 'completed'} conversation with ${history} historical turns`, async ({ page, baseURL }) => {
    await page.route('**/api/config', route => route.fulfill({ json: {} }));
    await page.goto(new URL(`/e2e/fixtures/streaming-scroll.html?history=${history}`, baseURL).href);
    await page.evaluate(running => {
      window.streamFixture.beginTurn();
      window.streamFixture.text('A paragraph in the current response.\n\n'.repeat(100));
      if (!running) window.streamFixture.complete();
    }, running);
    const chat = viewport(page);
    await expect.poll(() => remaining(chat)).toBeLessThan(3);
    await chat.click({ position: { x: 65, y: 300 } });
    await page.keyboard.press('Home');
    await expect.poll(() => position(chat)).toBeLessThan(3);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => position(chat)).toBeGreaterThan(20);
    await page.keyboard.press('PageDown');
    await expect.poll(() => position(chat)).toBeGreaterThan(500);
    for (let index = 0; index < 3; index++) {
      await page.keyboard.press('End');
      await expect.poll(() => remaining(chat)).toBeLessThan(3);
      await page.keyboard.press('PageUp');
      await expect.poll(() => remaining(chat)).toBeGreaterThan(500);
    }
    await page.keyboard.press('End');
    await page.mouse.wheel(0, 800);
    if (running) {
      await page.evaluate(() => window.streamFixture.text('Growing output at the bottom.\n\n'.repeat(120)));
      await expect(page.getByText('Growing output at the bottom.', { exact: true })).toHaveCount(120);
    }
    await expect.poll(() => remaining(chat)).toBeLessThan(3);
    const samples = await chat.evaluate(async node => {
      const values = [];
      for (let i = 0; i < 20; i++) {
        await new Promise(requestAnimationFrame);
        values.push(node.scrollHeight - node.clientHeight - node.scrollTop);
      }
      return values;
    });
    expect(Math.max(...samples)).toBeLessThan(3);
  });
}
