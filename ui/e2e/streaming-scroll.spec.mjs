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
  await viewport(page).hover({ position: { x: 60, y: 300 } });
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

test('scrolling back through a live turn never replays already presented reply text', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.streamFixture.beginTurn();
    window.streamFixture.text('An earlier progress paragraph.\n\n'.repeat(30) + 'End of the earlier reply.');
  });
  const earlier = page.locator('.chat-message[data-message-key]').filter({ hasText: 'End of the earlier reply.' });
  await expect(earlier).toHaveCount(1);
  const key = await earlier.getAttribute('data-message-key');
  await page.evaluate(() => {
    for (let index = 0; index < 90; index++) {
      window.streamFixture.tool(`progress-${index}`);
      window.streamFixture.finishTool(`progress-${index}`);
      window.streamFixture.text(`Progress ${index}.\n\n`.repeat(15));
    }
  });
  await expect(page.locator('[data-virtualized-messages="true"]')).toHaveCount(1);
  await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
  await expect(earlier).toHaveCount(0);
  await page.evaluate(key => {
    window.replyPresentationSamples = [];
    window.replyPresentationObserver = new MutationObserver(() => {
      const row = [...document.querySelectorAll('[data-message-key]')].find(node => node.dataset.messageKey === key);
      if (row) window.replyPresentationSamples.push(row.textContent.includes('End of the earlier reply.'));
    });
    window.replyPresentationObserver.observe(document.querySelector('[data-chat-search-surface]'), { childList: true, subtree: true, characterData: true });
  }, key);
  await page.locator('[data-turn-index="24"]').click();
  await expect(earlier).toBeVisible();
  await page.waitForTimeout(350);
  const samples = await page.evaluate(() => {
    window.replyPresentationObserver.disconnect();
    return window.replyPresentationSamples;
  });
  expect(samples.length).toBeGreaterThan(0);
  expect(samples.every(Boolean)).toBe(true);
});

test('continuous upward wheels retain their visual displacement during a long live turn', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.streamFixture.beginTurn();
    for (let index = 0; index < 90; index++) {
      window.streamFixture.text(`Progress ${index}.\n\n`.repeat(15));
      window.streamFixture.tool(`step-${index}`);
      window.streamFixture.finishTool(`step-${index}`);
    }
    window.streamFixture.text('Current output.\n\n'.repeat(80));
  });
  await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
  await viewport(page).hover({ position: { x: 60, y: 300 } });
  await page.evaluate(() => {
    let paragraphs = 80;
    window.streamingScrollTimer = setInterval(() => window.streamFixture.text('Current output.\n\n'.repeat(++paragraphs)), 50);
  });
  try {
    for (let step = 0; step < 30; step++) {
      await viewport(page).evaluate(node => node.addEventListener('wheel', () => {
        const row = [...node.querySelectorAll('[data-message-key]')]
          .find(item => item.getBoundingClientRect().bottom > node.getBoundingClientRect().top);
        window.wheelReadingPosition = { key: row.dataset.messageKey, top: row.getBoundingClientRect().top };
      }, { once: true, capture: true }));
      await page.mouse.wheel(0, -250);
      // Check the visual position, not scrollTop: measuring rows above the
      // viewport legitimately changes scrollTop while preserving what is read.
      await expect.poll(() => viewport(page).evaluate(node => {
        const { key, top } = window.wheelReadingPosition;
        const row = [...node.querySelectorAll('[data-message-key]')].find(item => item.dataset.messageKey === key);
        return row ? row.getBoundingClientRect().top - top : -10000;
      })).toBeCloseTo(250, 0);
      const settledOffsets = await viewport(page).evaluate(async node => {
        const offsets = [];
        for (let frame = 0; frame < 3; frame++) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          const { key, top } = window.wheelReadingPosition;
          const row = [...node.querySelectorAll('[data-message-key]')].find(item => item.dataset.messageKey === key);
          offsets.push(row ? row.getBoundingClientRect().top - top : -10000);
        }
        return offsets;
      });
      expect(settledOffsets.every(offset => Math.abs(offset - 250) < 1)).toBe(true);
      await expect(viewport(page)).toHaveAttribute('data-scroll-follow-paused', 'true');
    }
  } finally {
    await page.evaluate(() => clearInterval(window.streamingScrollTimer));
  }
  expect(Number(await page.locator('[data-rendered-message-count]').getAttribute('data-rendered-message-count'))).toBeLessThanOrEqual(60);
});

test('thinking keeps its reading position through tools and remains available in the completed process', async ({ page }) => {
  await open(page);
  await page.evaluate((text) => window.streamFixture.think(text), lines(30));
  const liveThinking = page.getByRole('button', { name: /^Thinking for \d+s$/ });
  await expect(liveThinking).toHaveAttribute('aria-expanded', 'true');
  const thinking = page.getByRole('region', { name: 'Live thinking content' });
  await expect(thinking.getByText(/Thinking line 30/)).toBeVisible();
  await expect(liveThinking).toHaveCount(1);
  await thinking.hover();
  await page.mouse.wheel(0, -70);
  await expect.poll(() => distance(thinking)).toBeGreaterThan(30);
  const readingTop = await top(thinking);
  const outerTop = await top(viewport(page));
  await page.evaluate((text) => window.streamFixture.think(text), lines(45));
  await page.waitForTimeout(500);
  expect(Math.abs(await top(thinking) - readingTop)).toBeLessThan(2);
  await page.evaluate(() => window.streamFixture.tool());
  const completedThinking = page.getByRole('button', { name: /^Thought for \d+s$/ });
  await expect(completedThinking).toHaveAttribute('aria-expanded', 'false');
  await completedThinking.click();
  await expect(thinking).toBeVisible();
  expect(Math.abs(await top(thinking) - readingTop)).toBeLessThan(2);
  // A collapsing 400px block can clamp the outer scroll range. Keep the reader paused,
  // retain the inner position, and never force the conversation forward.
  await expect(viewport(page)).toHaveAttribute('data-scroll-follow-paused', 'true');
  expect(await top(viewport(page))).toBeLessThanOrEqual(outerTop + 1);
  await page.evaluate(() => { window.streamFixture.finishTool(); window.streamFixture.text('Final answer.'); window.streamFixture.complete(); });
  await expect(page.locator('[data-turn-process-header] button').last()).toHaveAttribute('aria-expanded', 'true');
  const completedProcess = page.locator('[data-process-block] > button');
  await expect(completedProcess).toHaveAttribute('aria-expanded', 'true');
  await expect(thinking).toBeVisible();
  await expect(thinking).toContainText('Thinking line 45');
  await page.screenshot({ path: test.info().outputPath('thinking-reading-position.png') });
});

test('web fetch has one status in plan mode and empty results finish it; parallel calls remain distinct', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.streamFixture.setMode('plan'); window.streamFixture.tool(); });
  await expect(page.getByRole('button', { name: 'Fetching https://example.com/fetch-1', exact: true })).toHaveCount(1);
  await page.evaluate(() => window.streamFixture.finishTool());
  await expect(page.getByRole('button', { name: 'Fetched https://example.com/fetch-1', exact: true })).toHaveCount(1);
  await page.evaluate(() => { window.streamFixture.tool('fetch-2'); window.streamFixture.tool('fetch-3'); window.streamFixture.finishTool('fetch-2'); });
  const waiting = page.locator('[data-process-block] > button');
  await expect(waiting).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: /^Fetching https:\/\/example.com\/fetch-/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Fetched https://example.com/fetch-2', exact: true })).toHaveCount(1);
  await page.evaluate(() => window.streamFixture.finishTool('fetch-3'));
  await expect(page.getByRole('button', { name: /^Fetching https:\/\/example.com\/fetch-/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Fetched https:\/\/example.com\/fetch-/ })).toHaveCount(3);
});

test('stream updates do not repeatedly recenter an existing search match', async ({ page }) => {
  await open(page);
  await viewport(page).click({ position: { x: 60, y: 300 } });
  await page.keyboard.press('Meta+f');
  await page.getByRole('searchbox').fill('needle 10');
  await expect(page.locator('mark.chat-history-search-highlight-active')).toBeVisible();
  await viewport(page).hover({ position: { x: 60, y: 300 } });
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
  await viewport(page).hover({ position: { x: 60, y: 300 } });
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

test('automatic layout shrink and growth keep following without reader input', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.unwantedPauses = [];
    const node = document.querySelector('[data-chat-search-surface]');
    new MutationObserver(records => {
      if (node.dataset.scrollFollowPaused === 'true' || records.some(r => r.oldValue === 'true')) window.unwantedPauses.push(true);
    }).observe(node, { attributes: true, attributeFilter: ['data-scroll-follow-paused'], attributeOldValue: true });
  });
  for (let step = 0; step < 3; step++) {
    await page.evaluate(text => window.streamFixture.think(text), lines(40 + step * 10));
    await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
    await page.evaluate(id => window.streamFixture.tool(id), `layout-tool-${step}`);
    await expect(page.locator('[data-thinking-state="completed"]').last()).toBeVisible();
    await page.evaluate(id => window.streamFixture.finishTool(id), `layout-tool-${step}`);
    await page.evaluate(text => window.streamFixture.text(text), `Progress ${step}.\n\n`.repeat(30));
    await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
    await expect(viewport(page)).toHaveAttribute('data-scroll-follow-paused', 'false');
    await expect(page.getByRole('button', { name: 'Back to latest' })).toHaveCount(0);
  }
  await page.evaluate(() => { window.streamFixture.text('Final answer.'); window.streamFixture.complete(5000); });
  await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
  expect(await page.evaluate(() => window.unwantedPauses)).toEqual([]);
});

test('manually opened tools keep their parents open and hold the reader through new replies', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.streamFixture.beginTurn();
    window.streamFixture.tool('inspect', 'read_file', { file_path: 'example.ts' });
    window.streamFixture.finishTool('inspect', 'Inspectable contents.\n'.repeat(12)); });
  const tool = page.locator('.tool-call[data-tool-id="inspect"] > div > button');
  await tool.click();
  const group = page.locator('[data-process-block] > button');
  await expect(viewport(page)).toHaveAttribute('data-scroll-follow-paused', 'true');
  await page.waitForTimeout(300);
  const readingY = await tool.evaluate(node => node.getBoundingClientRect().top);
  await page.evaluate(() => window.streamFixture.text('A long follow-up response.\n\n'.repeat(70)));
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(tool).toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(700);
  expect(Math.abs(await tool.evaluate(node => node.getBoundingClientRect().top) - readingY)).toBeLessThan(2);
  await page.evaluate(() => window.streamFixture.complete(5000));
  await expect(page.locator('[data-turn-process-header] button')).toHaveAttribute('aria-expanded', 'true');
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(tool).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Back to latest' }).click();
  await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
  await expect(tool).toHaveAttribute('aria-expanded', 'true');
});
