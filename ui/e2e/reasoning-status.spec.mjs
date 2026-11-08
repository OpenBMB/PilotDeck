import { test, expect } from '@playwright/test';

test('reasoning clocks open automatically, freeze at the next step, and share tool row metrics in every palette', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-05T00:00:00Z') });
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  await page.evaluate(() => window.streamFixture.think('Compare the implementation before choosing the next step.'));
  const thinking = page.getByRole('button', { name: /^Thinking for \d+s$/ });
  await expect(thinking).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('region', { name: 'Live thinking content' })).toBeVisible();
  await page.clock.runFor(3100);
  await expect(thinking).toHaveText('Thinking for 3s');
  await page.evaluate(() => window.streamFixture.tool());
  const finished = page.getByRole('button', { name: 'Thought for 3s', exact: true });
  await expect(finished).toHaveAttribute('aria-expanded', 'false');
  await finished.focus();
  await page.keyboard.press('Enter');
  await expect(finished).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Enter');
  await page.clock.runFor(10000);
  await expect(finished).toHaveText('Thought for 3s');
  await page.evaluate(() => { window.streamFixture.finishTool(); window.streamFixture.think('Check the result.'); });
  await page.clock.runFor(1100);
  await page.evaluate(() => { window.streamFixture.tool('fetch-2'); window.streamFixture.tool('fetch-3'); });
  await page.evaluate(() => { window.streamFixture.finishTool('fetch-2'); window.streamFixture.finishTool('fetch-3'); window.streamFixture.think('Summarize the findings.'); });
  await expect(page.locator('[data-thinking-state="running"]')).toContainText('Summarize the findings.');
  await page.locator('[data-thinking-state] > button[aria-expanded="true"]').evaluateAll(nodes => nodes.forEach(node => node.click()));
  const triggers = page.locator('[data-turn-trace] .chat-process-trigger');
  await expect(triggers).toHaveCount(6);
  await expect.poll(() => triggers.evaluateAll(nodes => nodes.slice(1).every((node, i) => Math.abs(node.getBoundingClientRect().top - nodes[i].getBoundingClientRect().bottom - 8) < 0.01))).toBe(true);

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
  const restored = page.locator('[data-thinking-state] > button');
  await expect(restored).toHaveAttribute('aria-expanded', 'false');
  await restored.click();
  await expect(page.getByRole('region', { name: 'Live thinking content' })).toContainText('restored from history');
  await page.evaluate(() => window.streamFixture.think('Continue with the next step.'));
  const live = page.locator('[data-thinking-state="running"] svg').first();
  expect(await live.evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
});

test('live and completed tools keep semantic icons in every palette', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  await page.evaluate(() => {
    window.streamFixture.beginTurn();
    window.streamFixture.think('Prepare a small report.');
    window.streamFixture.tool('new-file', 'write_file', { file_path: 'report.txt', content: 'Report' });
  });
  const writeIcon = page.locator('[data-tool-id="new-file"] > div > button > svg').first();
  await expect(writeIcon).toHaveClass(/lucide-file-plus-2/);
  await expect(writeIcon).toHaveCSS('animation-name', 'none');
  const writeText = page.locator('[data-tool-id="new-file"] .chat-process-shimmer');
  await expect(writeText).toHaveCSS('animation-name', 'chat-process-shimmer');
  await expect(page.locator('[data-process-block] > button > svg').first()).toHaveClass(/lucide-file-plus-2/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(writeIcon).toHaveCSS('animation-name', 'none');
  await expect(writeText).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    window.streamFixture.finishTool('new-file', 'Written');
    for (const [id, name, input] of [
      ['edit', 'edit_file', { file_path: 'report.txt', old_string: 'Report', new_string: 'Final report' }],
      ['read', 'Read', { file_path: 'report.txt' }],
      ['files', 'glob', { pattern: '*.txt' }],
      ['skill', 'read_skill', { skillName: 'reporting' }],
      ['image', 'generate_image', { prompt: 'Report illustration', purpose: 'intermediate' }],
      ['video', 'generate_video', { prompt: 'Report animation', purpose: 'intermediate' }],
      ['external', 'mcp__notes__lookup', { query: 'report' }],
      ['browser', 'browser_navigate', { url: 'https://example.com' }],
      ['unknown', 'custom_action', {}],
    ]) { window.streamFixture.tool(id, name, input); window.streamFixture.finishTool(id, 'Done'); }
  });
  await expect(writeIcon).toHaveClass(/lucide-file-plus-2/);
  await expect(writeIcon).toHaveCSS('animation-name', 'none');
  const groupIcon = page.locator('[data-process-block] > button > svg').first();
  await expect(groupIcon).toHaveClass(/lucide-layers/);
  for (const [id, icon] of [['edit', 'file-pen-line'], ['read', 'file-text'], ['files', 'file-search'],
    ['skill', 'book-open'], ['image', 'image'], ['video', 'clapperboard'], ['external', 'plug'],
    ['browser', 'app-window'], ['unknown', 'wrench']]) {
    await expect(page.locator(`[data-tool-id="${id}"] > div > button > svg`).first()).toHaveClass(new RegExp(`lucide-${icon}(\\s|$)`));
  }
  await page.evaluate(() => { window.streamFixture.text('The report is ready.'); window.streamFixture.complete(5000); });
  await page.locator('[data-turn-process-header] button').click();
  await page.locator('[data-process-block] > button').click();
  for (const preset of ['default', 'paper', 'mint', 'sand', 'custom', 'dark']) {
    await page.evaluate(p => window.streamFixture.setAppearance(p === 'dark' ? 'default' : p, p === 'dark'), preset);
    await page.mouse.move(0, 0);
    const icons = page.locator('[data-tool-id] > div > button > svg:first-child');
    await expect(icons).toHaveCount(10);
    const metrics = await icons.evaluateAll(nodes => nodes.map(node => ({
      width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
      stroke: node.getAttribute('stroke-width'), hidden: node.getAttribute('aria-hidden'),
      color: getComputedStyle(node).color,
      rowColor: getComputedStyle(node.closest('button')).color,
    })));
    expect(metrics.every(m => m.width === 14 && m.height === 14 && m.stroke === '1.8' && m.hidden === 'true'), preset).toBe(true);
    // Icons inherit their own row, including in-flight theme/hover transitions.
    expect(metrics.every(m => m.color === m.rowColor), preset).toBe(true);
  }
  await page.evaluate(() => { window.streamFixture.setAppearance('mint'); return window.streamFixture.setLanguage('zh-CN'); });
  await expect(writeIcon).toHaveClass(/lucide-file-plus-2/);
  await page.screenshot({ path: test.info().outputPath('tool-icons-light.png'), animations: 'disabled' });
  await page.evaluate(() => window.streamFixture.setAppearance('default', true));
  await page.screenshot({ path: test.info().outputPath('tool-icons-dark.png'), animations: 'disabled' });
});
