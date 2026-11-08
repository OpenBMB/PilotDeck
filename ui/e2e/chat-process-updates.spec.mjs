import { test, expect } from '@playwright/test';

test('a new message folds inspected work and removes the previous file card', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  await page.evaluate(() => {
    window.streamFixture.beginTurn('first-user');
    window.streamFixture.think('Inspect the implementation.');
    window.streamFixture.tool('first-tool', 'run_command', { command: 'check first' });
    window.streamFixture.finishTool('first-tool', 'First result');
    window.streamFixture.text('First task complete.');
    window.streamFixture.files();
    window.streamFixture.complete(5000);
  });
  const card = page.getByTestId('turn-changes-card');
  await expect(card).toBeVisible();
  const oldTurn = page.locator('[data-turn-process-header] button').first();
  await oldTurn.click();
  const oldProcess = page.locator('[data-process-block] > button').first();
  await oldProcess.click();
  await page.locator('[data-tool-id="first-tool"] button[aria-expanded]').first().click();
  await page.locator('[data-thinking-state] > button').click();
  await page.evaluate(() => window.streamFixture.beginTurn('second-user', 'Continue with the next task.'));
  await expect(page.getByText('Continue with the next task.', { exact: true })).toBeVisible();
  await expect(oldTurn).toHaveAttribute('aria-expanded', 'false');
  await expect(card).toHaveCount(0);
  await oldTurn.click();
  await expect(oldProcess).toHaveAttribute('aria-expanded', 'false');
  await oldProcess.click();
  await expect(page.locator('[data-tool-id="first-tool"] button[aria-expanded]').first()).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-thinking-state] > button')).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({ path: test.info().outputPath('new-turn-folding.png') });
});

test('long work folds ten calls at a time and shows the latest action without indentation', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  await page.evaluate(() => {
    window.streamFixture.beginTurn();
    for (let index = 0; index < 100; index++) {
      window.streamFixture.tool(`batch-${index}`, 'run_command', { command: `check ${index}` });
      window.streamFixture.finishTool(`batch-${index}`, 'ok');
    }
    window.streamFixture.tool('current', 'run_command', { command: 'verify latest output' });
  });
  const blocks = page.locator('[data-process-block]');
  await expect(blocks).toHaveCount(11);
  await expect(page.locator('[data-process-block] > button[aria-expanded="false"]')).toHaveCount(10);
  const live = blocks.last();
  await expect(live.locator(':scope > button')).toContainText('verify latest output');
  await expect(live.locator(':scope > button')).toHaveAttribute('aria-expanded', 'true');
  const call = live.locator('[data-tool-id="current"] button[aria-expanded]');
  await expect(call).toBeVisible();
  const parentBox = await live.locator(':scope > button').boundingBox();
  const childBox = await call.boundingBox();
  expect(Math.abs(parentBox.x - childBox.x)).toBeLessThan(1);
  await expect(live.locator('.chat-process-shimmer')).toHaveCount(2);
  const shimmer = live.locator(':scope > button .chat-process-shimmer');
  await expect(shimmer).toHaveCSS('animation-duration', '3.2s');
  const firstPosition = await shimmer.evaluate(node => getComputedStyle(node).backgroundPosition);
  await expect.poll(() => shimmer.evaluate(node => getComputedStyle(node).backgroundPosition)).not.toBe(firstPosition);
  await page.screenshot({ path: test.info().outputPath('long-work-light.png') });
  await page.evaluate(() => { window.streamFixture.setLanguage('zh-CN'); window.streamFixture.setAppearance('default', true); });
  await expect(live.locator(':scope > button')).toContainText('verify latest output');
  await page.screenshot({ path: test.info().outputPath('long-work-dark-zh.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(shimmer).toHaveCSS('animation-name', 'none');
  await expect(shimmer).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');
  await page.evaluate(() => {
    window.streamFixture.finishTool('current', 'verified');
    window.streamFixture.think('Rechecking the final result.');
  });
  await expect(live.locator(':scope > button')).toContainText('思考');
  // Old batch details remain available, including the first command.
  await blocks.first().locator(':scope > button').click();
  await expect(blocks.first().locator('[data-tool-id]')).toHaveCount(10);
});

test('reverse momentum frames remain reader-owned while a response streams', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-scroll.html');
  await page.evaluate(() => window.streamFixture.text('Streaming paragraph.\n\n'.repeat(80)));
  const viewport = page.locator('[data-chat-search-surface]');
  await expect.poll(() => viewport.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(3);
  await viewport.hover({ position: { x: 50, y: 300 } });
  await page.mouse.wheel(0, -300);
  await expect(viewport).toHaveAttribute('data-scroll-follow-paused', 'true');
  await page.waitForTimeout(300);
  for (const direction of [-1, 1, -1, 1]) {
    const expected = await viewport.evaluate((node, direction) => {
      node.dispatchEvent(new WheelEvent('wheel', { deltaY: direction * 60, bubbles: true }));
      node.scrollTop += direction * 30;
      node.dispatchEvent(new Event('scroll'));
      node.dispatchEvent(new WheelEvent('wheel', { deltaY: -direction * 60, bubbles: true }));
      node.scrollTop += direction * 10;
      const top = node.scrollTop;
      window.streamFixture.text('Streaming paragraph.\n\n'.repeat(100));
      return top;
    }, direction);
    await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBeCloseTo(expected, 0);
    await page.waitForTimeout(150);
    expect(await viewport.evaluate(node => node.scrollTop)).toBeCloseTo(expected, 0);
  }
});

test('image views, file edits and other actions share the batch limit and keep semantic summaries', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  await page.evaluate(() => {
    window.streamFixture.beginTurn();
    const actions = [
      ['read_file', { file_path: 'source.ts' }], ['Read', { file_path: 'diagram.png' }],
      ['view_image', { path: 'reference.jpg' }], ['edit_file', { file_path: 'source.ts' }],
      ['write_file', { file_path: 'result.ts' }], ['web_search', { query: 'reference' }],
      ['web_fetch', { url: 'https://example.com' }], ['bash', { command: 'verify' }],
      ['browser_navigate', { url: 'https://example.com' }], ['read_skill', { skillName: 'testing' }],
    ];
    actions.forEach(([name, input], index) => {
      window.streamFixture.tool(`mixed-${index}`, name, input);
      window.streamFixture.finishTool(`mixed-${index}`, 'ok');
    });
    window.streamFixture.tool('latest-image', 'read_file', { file_path: 'latest.png' });
  });
  const batches = page.locator('[data-process-block]');
  await expect(batches).toHaveCount(2);
  const summary = batches.first().locator(':scope > button');
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(summary).toContainText('Viewed 2 images');
  await expect(summary).toContainText('Edited 2 files');
  await expect(summary).toContainText('Ran 1 command');
  await expect(summary).toContainText('Loaded 1 skill');
  await expect(batches.last().locator(':scope > button')).toContainText('Viewing latest.png');
  await expect(page.getByRole('button', { name: 'Viewing latest.png', exact: true })).toBeVisible();
  await page.evaluate(() => window.streamFixture.setLanguage('zh-CN'));
  await expect(summary).toContainText('已查看 2 张图片');
  await expect(summary).toContainText('已编辑 2 个文件');
  await expect(summary).toContainText('已运行 1 条命令');
  await page.screenshot({ path: test.info().outputPath('mixed-actions-summary.png') });
  await summary.click();
  await expect(batches.first().locator('[data-tool-id]')).toHaveCount(10);
});
