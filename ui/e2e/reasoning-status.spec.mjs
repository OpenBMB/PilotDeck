import { test, expect } from '@playwright/test';

test('reasoning clocks stay collapsed, freeze at the next step, and share tool row metrics in every palette', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-05T00:00:00Z') });
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  await page.evaluate(() => window.streamFixture.think('Compare the implementation before choosing the next step.'));
  const thinking = page.getByRole('button', { name: /^Thinking for \d+s$/ });
  await expect(thinking).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('region', { name: 'Live thinking content' })).toHaveCount(0);
  await page.clock.runFor(3100);
  await expect(thinking).toHaveText('Thinking for 3s');
  await thinking.focus();
  await page.keyboard.press('Enter');
  await expect(thinking).toHaveAttribute('aria-expanded', 'true');
  await page.evaluate(() => window.streamFixture.tool());
  const finished = page.getByRole('button', { name: 'Thought for 3s', exact: true });
  await expect(finished).toHaveAttribute('aria-expanded', 'false');
  await page.clock.runFor(10000);
  await expect(finished).toHaveText('Thought for 3s');
  await page.evaluate(() => { window.streamFixture.finishTool(); window.streamFixture.think('Check the result.'); });
  await page.clock.runFor(1100);
  await page.evaluate(() => { window.streamFixture.tool('fetch-2'); window.streamFixture.tool('fetch-3'); });
  await page.evaluate(() => { window.streamFixture.finishTool('fetch-2'); window.streamFixture.finishTool('fetch-3'); window.streamFixture.think('Summarize the findings.'); });
  const triggers = page.locator('.chat-process-trigger');
  await expect(triggers).toHaveCount(5);

  for (const preset of ['default', 'blue', 'mint', 'apricot', 'lavender', 'rose', 'custom', 'dark']) {
    await page.evaluate((preset) => window.streamFixture.setAppearance(preset === 'dark' ? 'default' : preset, preset === 'dark'), preset);
    // CSS transitions use browser time, independently of the reasoning clock.
    const expectedColor = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'hsl(var(--muted-foreground))';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect(triggers.nth(1)).toHaveCSS('color', expectedColor);
    const metrics = await triggers.evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      const icon = node.querySelector('svg').getBoundingClientRect();
      const text = node.children[1].getBoundingClientRect();
      const style = getComputedStyle(node);
      return { y: rect.y, bottom: rect.bottom, height: rect.height, iconX: icon.x, iconY: icon.y + icon.height / 2,
        textX: text.x, font: style.fontSize, line: style.lineHeight, color: style.color,
        label: node.textContent, hovered: node.matches(':hover'), focused: node.matches(':focus') };
    }));
    for (const [index, row] of metrics.entries()) {
      expect(row.height, preset).toBe(24);
      expect(row.font, preset).toBe('13px');
      expect(row.line, preset).toBe('24px');
      expect(row.iconX, preset).toBe(metrics[0].iconX);
      expect(row.textX, preset).toBe(metrics[0].textX);
      expect(row.iconY, preset).toBe(row.y + 12);
      if (index) expect(row.y - metrics[index - 1].bottom, preset).toBe(8);
    }
    expect(new Set(metrics.map((row) => row.color)).size, `${preset}: ${JSON.stringify(metrics)}`).toBe(1);
  }
  await page.evaluate(() => { window.streamFixture.setAppearance('mint'); return window.streamFixture.setLanguage('zh-CN'); });
  await expect(page.getByRole('button', { name: '已思考 3 秒', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^正在思考 \d+ 秒$/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('reasoning-mint-zh.png'), animations: 'disabled' });
  await page.evaluate(() => window.streamFixture.setAppearance('default', true));
  await page.screenshot({ path: test.info().outputPath('reasoning-dark-zh.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('restored reasoning shows its measured duration and reduced motion keeps the indicator still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  await page.evaluate(() => window.streamFixture.restoreThinking(8700));
  const restored = page.getByRole('button', { name: 'Thought for 8s' });
  await expect(restored).toHaveAttribute('aria-expanded', 'false');
  await restored.click();
  await expect(page.getByRole('region', { name: 'Live thinking content' })).toContainText('restored from history');
  await page.evaluate(() => window.streamFixture.think('Continue with the next step.'));
  const live = page.locator('[data-thinking-state="running"] svg').first();
  expect(await live.evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
});
