import { test, expect } from '@playwright/test';

async function watchHeight(page, selector) {
  await page.evaluate(selector => {
    const node = document.querySelector(selector);
    window.transitionSamples = [];
    window.originalTransitionNode = node;
    const end = performance.now() + 500;
    const sample = () => {
      window.transitionSamples.push(node?.getBoundingClientRect().height ?? 0);
      if (performance.now() < end) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, selector);
}

async function expectSmoothClose(page) {
  await expect.poll(() => page.evaluate(() => window.transitionSamples.at(-1))).toBe(0);
  const heights = await page.evaluate(() => window.transitionSamples);
  expect(heights.some(height => height > 0 && height < Math.max(...heights) - 1)).toBe(true);
}

test('thinking closes smoothly, continuous work keeps its seat, and prose closes just its interval', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  await page.evaluate(() => window.streamFixture.think('A reasoning paragraph.\n\n'.repeat(20)));
  const thinkingBody = '[data-thinking-state] > .chat-process-disclosure';
  await expect.poll(() => page.locator(thinkingBody).evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(100);
  await watchHeight(page, thinkingBody);
  await page.evaluate(() => window.streamFixture.tool());
  await expectSmoothClose(page);
  const seat = page.locator('[data-process-block]');
  await seat.evaluate(node => { window.workSeat = node; });
  await page.evaluate(() => { window.streamFixture.finishTool(); window.streamFixture.think('Check again.'); });
  expect(await seat.evaluate(node => node === window.workSeat)).toBe(true);
  await expect(seat.locator(':scope > button')).toHaveAttribute('aria-expanded', 'true');
  await watchHeight(page, '[data-process-block] > .chat-process-disclosure');
  await page.evaluate(() => window.streamFixture.text('First visible progress reply.'));
  await expectSmoothClose(page);
  expect(await seat.evaluate(node => node === window.workSeat)).toBe(true);
  await expect(page.getByText('First visible progress reply.', { exact: true })).toBeVisible();
  await page.evaluate(() => { window.streamFixture.tool('next-tool'); window.streamFixture.finishTool('next-tool');
    window.streamFixture.text('Final visible answer.'); window.streamFixture.complete(); });
  await expect(page.locator('[data-process-block]')).toHaveCount(2);
  await expect(page.locator('[data-process-block] > button[aria-expanded="false"]')).toHaveCount(2);
  await expect(page.getByText('First visible progress reply.', { exact: true })).toBeVisible();
  await expect(page.getByText('Final visible answer.', { exact: true })).toBeVisible();
});

test('answering a question collapses its original card while a batched final reply drains gradually', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  const fullText = 'The task continues with the selected route. '.repeat(100) + 'FINAL_END';
  await page.evaluate(text => window.streamFixture.askQuestion(text), fullText);
  const question = page.locator('[data-question-seat]');
  await question.getByRole('button', { name: /Continue Keep working/ }).click();
  await page.screenshot({ path: test.info().outputPath('question-light.png'), animations: 'disabled' });
  await page.evaluate(() => { window.streamFixture.setAppearance('default', true); return window.streamFixture.setLanguage('zh-CN'); });
  await page.screenshot({ path: test.info().outputPath('question-dark-zh.png'), animations: 'disabled' });
  await watchHeight(page, '[data-question-seat]');
  await question.getByRole('button', { name: /提交/ }).click();
  // The same seat survives the response dispatch; its subtree is inaccessible during exit.
  expect(await page.evaluate(() => window.originalTransitionNode.getAttribute('aria-hidden'))).toBe('true');
  const firstLength = await page.locator('[class~="group/assistant-msg"]').last().textContent();
  expect(firstLength?.length ?? 0).toBeLessThan(fullText.length);
  await expectSmoothClose(page);
  await expect(question).toHaveCount(0);
  await expect(page.getByText(/FINAL_END/)).toBeVisible();
  await expect(page.locator('[data-question-seat]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Next step Continue 已回答/ })).toBeVisible();
});

test('reduced motion closes disclosures without a height transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  await page.evaluate(() => window.streamFixture.think('A short thought.'));
  const body = page.locator('[data-thinking-state] > .chat-process-disclosure');
  expect(await body.evaluate(node => parseFloat(getComputedStyle(node).transitionDuration))).toBeLessThan(0.001);
  await page.evaluate(() => window.streamFixture.tool());
  await expect.poll(() => body.evaluate(node => node.getBoundingClientRect().height)).toBe(0);
});
