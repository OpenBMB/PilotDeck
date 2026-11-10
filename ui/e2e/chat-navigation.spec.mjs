import { test, expect } from './fixtures/scroll-test.mjs';

const viewport = page => page.locator('[data-chat-search-surface]');
const position = locator => locator.evaluate(node => node.scrollTop);
const remaining = locator => locator.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);

test('portaled composer menus use the same scroll-only scrollbar behavior', async ({ page, baseURL }) => {
  const selection = { mode: 'model', provider: 'synthetic', model: 'model-0' };
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname === '/api/models'
    ? { defaultSelection: selection, items: Array.from({ length: 40 }, (_, i) => ({
      id: `synthetic/model-${i}`, provider: 'synthetic', model: `model-${i}`, displayName: `Model ${i}`, available: true, capabilities: {},
    })) } : {} }));
  await page.goto(new URL('/e2e/fixtures/model-selection.html', baseURL).href);
  const trigger = page.getByRole('button', { name: 'Model 0', exact: true });
  await trigger.click();
  const list = page.locator('[data-model-list]');
  const color = () => list.evaluate(node => getComputedStyle(node).scrollbarColor);
  const hidden = 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)';
  await expect.poll(color).toBe(hidden);
  const width = await list.evaluate(node => node.clientWidth);
  await list.hover();
  expect(await color()).toBe(hidden);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await expect(list).toHaveAttribute('data-chat-scrolling', '');
  expect(await color()).not.toBe(hidden);
  expect(await list.evaluate(node => node.clientWidth)).toBe(width);
  await expect.poll(color).toBe(hidden);
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await trigger.click();
  await expect.poll(color).toBe(hidden);
});

test('chat scrollbars reveal only the scrolling viewport without changing its width', async ({ page, baseURL }) => {
  await page.route('**/api/config', route => route.fulfill({ json: {} }));
  await page.goto(new URL('/e2e/fixtures/streaming-scroll.html', baseURL).href);
  const chat = viewport(page);
  const color = locator => locator.evaluate(node => getComputedStyle(node).scrollbarColor);
  const hidden = 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)';
  await expect.poll(() => color(chat)).toBe(hidden);
  const width = await chat.evaluate(node => node.clientWidth);
  await chat.hover({ position: { x: 65, y: 300 } });
  expect(await color(chat)).toBe(hidden);
  await page.mouse.wheel(0, -100);
  await expect(chat).toHaveAttribute('data-chat-scrolling', '');
  expect(await color(chat)).not.toBe(hidden);
  expect(await chat.evaluate(node => node.clientWidth)).toBe(width);
  await expect.poll(() => color(chat)).toBe(hidden);
  await page.evaluate(() => {
    window.streamFixture.beginTurn();
    window.streamFixture.tool('scrollbars-code', 'read_file', { file_path: 'example.ts' });
    window.streamFixture.finishTool('scrollbars-code', Array.from({ length: 100 }, (_, i) => `const line${i} = "${'example'.repeat(60)}";`).join('\n'));
    window.streamFixture.text('After the code.\n\n'.repeat(25) + '```javascript\nconst wide = "' + 'example'.repeat(100) + '";\n```');
  });
  await page.locator('[data-process-block] > button[aria-expanded="false"]').evaluateAll(nodes => nodes.forEach(node => node.click()));
  await page.locator('[data-tool-id="scrollbars-code"] > div > button[aria-expanded="false"]').evaluateAll(nodes => nodes.forEach(node => node.click()));
  const code = page.locator('[data-tool-id="scrollbars-code"] [data-chat-scroll-region]').last();
  await expect(code).toBeVisible();
  await code.hover();
  await expect.poll(() => color(chat)).toBe(hidden);
  await expect.poll(() => color(code)).toBe(hidden);
  const codeWidth = await code.evaluate(node => node.clientWidth);
  for (const dark of [false, true]) {
    await page.evaluate(dark => window.streamFixture.setAppearance('default', dark), dark);
    await code.hover();
    await expect.poll(() => color(chat)).toBe(hidden);
    await page.mouse.wheel(0, 60);
    await expect(code).toHaveAttribute('data-chat-scrolling', '');
    expect(await color(code)).not.toBe(hidden);
    expect(await color(chat)).toBe(hidden);
    expect(await code.evaluate(node => node.clientWidth)).toBe(codeWidth);
    await expect.poll(() => color(code)).toBe(hidden);
  }
  const horizontal = chat.locator('.markdown-code-block pre').last();
  await chat.locator('.markdown-code-block').last().getByRole('button', { name: 'Wrap code', exact: true }).click();
  await expect.poll(() => horizontal.evaluate(node => node.scrollWidth - node.clientWidth)).toBeGreaterThan(100);
  await chat.press('End');
  await expect.poll(() => remaining(chat)).toBeLessThan(3);
  await horizontal.hover();
  await expect.poll(() => color(chat)).toBe(hidden);
  await page.mouse.wheel(100, 0);
  await expect(horizontal).toHaveAttribute('data-chat-scrolling', '');
  expect(await color(horizontal)).not.toBe(hidden);
  expect(await color(chat)).toBe(hidden);
  await expect.poll(() => color(horizontal)).toBe(hidden);
});

test('user bubbles remain distinct and readable with the production dark theme stylesheet', async ({ page, baseURL }) => {
  await page.route('**/api/config', route => route.fulfill({ json: {} }));
  await page.goto(new URL('/e2e/fixtures/streaming-scroll.html?history=2', baseURL).href);
  await expect(page.getByText('Question 1', { exact: true })).toBeVisible();
  for (const preset of ['default', 'gray', 'blue', 'mint', 'apricot', 'rose', 'custom']) {
    await page.evaluate(preset => window.streamFixture.setAppearance(preset, true), preset);
    const contrast = await page.locator('.pd-user-message-bubble').last().evaluate(node => {
      const luminance = color => {
        const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
          value /= 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const style = getComputedStyle(node);
      const fill = luminance(style.backgroundColor);
      return { text: ratio(luminance(style.color), fill), surface: ratio(fill, luminance(getComputedStyle(node.closest('[data-chat-search-surface]')).backgroundColor)) };
    });
    expect(contrast.text, preset).toBeGreaterThanOrEqual(4.5);
    expect(contrast.surface, preset).toBeGreaterThan(1.3);
  }
  await page.screenshot({ path: test.info().outputPath('synthetic-dark-chat.png') });
});

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
    await page.keyboard.press('Control+End');
    await expect.poll(() => remaining(chat)).toBeLessThan(3);
    await page.keyboard.press('Control+Home');
    await expect.poll(() => position(chat)).toBeLessThan(3);
    await page.keyboard.press('Meta+ArrowDown');
    await expect.poll(() => remaining(chat)).toBeLessThan(3);
    await page.keyboard.press('Meta+ArrowUp');
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
