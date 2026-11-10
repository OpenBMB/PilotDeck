import { test, expect } from './fixtures/scroll-test.mjs';

const lines = (count) => Array.from({ length: count }, (_, i) => `Thinking line ${i + 1}: inspect and compare the implementation.`).join('\n\n');
const viewport = (page) => page.locator('[data-chat-search-surface]');
const top = (locator) => locator.evaluate((node) => node.scrollTop);
const distance = (locator) => locator.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);

for (const [language, label] of [['en', 'The user stopped the conversation'], ['zh-CN', '用户终止了会话']]) {
  test(`stopping folds the whole turn and leaves one translated notice outside it (${language})`, async ({ page, baseURL }) => {
    await page.route('**/api/config', route => route.fulfill({ json: {} }));
    await page.goto(new URL('/e2e/fixtures/streaming-scroll.html', baseURL).href);
    await page.evaluate(language => {
      window.streamFixture.setLanguage(language);
      window.streamFixture.beginTurn();
      window.streamFixture.think('Inspecting the implementation.');
      for (let index = 0; index < 4; index++) {
        window.streamFixture.tool(`stop-${index}`, 'read_file', { file_path: `example-${index}.ts` });
        window.streamFixture.finishTool(`stop-${index}`, 'Synthetic file contents.');
      }
      window.streamFixture.text('A partial reply before the stop.');
    }, language);
    await expect(page.getByText('A partial reply before the stop.', { exact: true })).toBeVisible();
    const header = page.locator('[data-turn-process-header] button').last();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    // Both timed Gateway completions and older untimed stop frames must work.
    await page.evaluate(timed => window.streamFixture.stop(timed), language === 'zh-CN');
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText(label, { exact: true })).toHaveCount(1);
    await expect(page.getByText(label, { exact: true })).toBeVisible();
    const foldedReply = page.locator('[data-turn-process-region]').filter({ hasText: 'A partial reply before the stop.' });
    await expect(foldedReply).toHaveAttribute('inert', '');
    await expect.poll(() => foldedReply.evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(1);
    await header.click();
    await expect(page.getByText('A partial reply before the stop.', { exact: true })).toBeVisible();
    await page.evaluate(timed => window.streamFixture.stop(timed), language === 'zh-CN');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText(label, { exact: true })).toHaveCount(1);
  });
}

test('code output consumes wheels inside its range and hands both edges to the conversation', async ({ page, baseURL }) => {
  await page.route('**/api/config', route => route.fulfill({ json: {} }));
  await page.goto(new URL('/e2e/fixtures/streaming-scroll.html', baseURL).href);
  await expect(page.getByText('Question 23', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.streamFixture.beginTurn();
    window.streamFixture.tool('scroll-code', 'read_file', { file_path: 'example.ts' });
    window.streamFixture.finishTool('scroll-code', Array.from({ length: 100 }, (_, index) => `const line${index} = ${index};`).join('\n'));
    window.streamFixture.text('After the code.\n\n'.repeat(25));
  });
  await expect(page.getByText('After the code.', { exact: true })).toHaveCount(25);
  await page.locator('[data-process-block] > button[aria-expanded="false"]').evaluateAll(nodes => nodes.forEach(node => node.click()));
  await page.locator('[data-tool-id="scroll-code"] > div > button[aria-expanded="false"]').evaluateAll(nodes => nodes.forEach(node => node.click()));
  const code = page.locator('[data-tool-id="scroll-code"]').getByRole('region', { name: 'Tool details' }).last();
  await expect.poll(() => code.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(300);
  await viewport(page).evaluate(node => {
    const code = node.querySelector('[data-tool-id="scroll-code"] [data-chat-scroll-region]');
    // Register native reader intent before positioning this nested-wheel case.
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
    node.scrollTop += code.getBoundingClientRect().top - node.getBoundingClientRect().top - 180;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect(code).toBeInViewport();
  for (const direction of [-1, 1]) {
    await code.evaluate(node => { node.scrollTop = 200; });
    const reading = await top(viewport(page));
    await code.hover();
    await page.mouse.wheel(0, direction * 60);
    await expect.poll(() => top(code)).toBeCloseTo(200 + direction * 60, 0);
    expect(await top(viewport(page))).toBeCloseTo(reading, 0);
    await code.evaluate((node, direction) => { node.scrollTop = direction < 0 ? 0 : node.scrollHeight; }, direction);
    await page.mouse.wheel(0, direction * 60);
    await expect.poll(() => top(viewport(page))).toBeCloseTo(reading + direction * 60, 0);
    await page.waitForTimeout(400);
    expect(await top(viewport(page))).toBeCloseTo(reading + direction * 60, 0);
  }
});

async function open(page) {
  await page.goto(new URL('/e2e/fixtures/streaming-scroll.html', test.info().project.use.baseURL).href);
  await expect(page.getByText('Question 23', { exact: true })).toBeVisible();
  await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
}

for (const working of [false, true]) {
  test(`a busy main thread cannot undo a delayed native wheel in a ${working ? 'live' : 'completed'} long conversation`, async ({ page, baseURL }) => {
    await page.route('**/api/config', route => route.fulfill({ json: {} }));
    await page.goto(new URL('/e2e/fixtures/streaming-scroll.html?history=100', baseURL).href);
    await expect(page.locator('[data-virtualized-messages="true"]')).toHaveCount(1);
    await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
    if (working) {
      await page.evaluate(() => {
        window.streamFixture.beginTurn();
        window.streamFixture.tool('busy-read', 'read_file', { file_path: 'example.ts' });
        window.streamFixture.finishTool('busy-read', 'Synthetic file contents.');
        window.streamFixture.text('Current output.\n\n'.repeat(12));
      });
      await expect(page.getByText('Current output.', { exact: true }).last()).toBeVisible();
      await expect(page.getByText('Current output.', { exact: true })).toHaveCount(12);
      await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
    }
    await viewport(page).hover({ position: { x: 60, y: 300 } });
    await viewport(page).evaluate(node => {
      const row = [...node.querySelectorAll('[data-message-key]')].find(item => !item.closest('[inert]')
        && item.getBoundingClientRect().bottom > node.getBoundingClientRect().top);
      window.delayedWheelAnchor = { key: row.dataset.messageKey, y: row.getBoundingClientRect().top };
      node.addEventListener('wheel', () => {
        // Model expensive Markdown/tool rendering after input is registered.
        // A blocking listener makes native movement wait for the busy thread,
        // exercising the event-after-input ordering on every platform.
        const until = performance.now() + 400;
        while (performance.now() < until) { /* deliberate main-thread stall */ }
      }, { once: true, passive: false });
    });
    await page.mouse.wheel(0, -120);
    const displacement = () => viewport(page).evaluate(node => {
      const anchor = window.delayedWheelAnchor;
      const row = [...node.querySelectorAll('[data-message-key]')].find(item => item.dataset.messageKey === anchor?.key);
      return row ? row.getBoundingClientRect().top - anchor.y : NaN;
    });
    await expect.poll(displacement).toBeCloseTo(120, 0);
    // Measurements may arrive after the native scroll appears to have landed.
    await page.waitForTimeout(1000);
    expect(await displacement()).toBeCloseTo(120, 0);
    await expect(viewport(page)).toHaveAttribute('data-scroll-follow-paused', 'true');
  });
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

test('bidirectional wheels retain their visual displacement during a long live turn', async ({ page }) => {
  test.setTimeout(60_000);
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
    for (const delta of [...Array(20).fill(-250), ...Array(12).fill(250), ...Array(12).fill(-250)]) {
      await viewport(page).evaluate(node => {
        window.wheelReadingPosition = undefined;
        node.addEventListener('wheel', () => {
          const row = [...node.querySelectorAll('[data-message-key]')]
            .find(item => item.getBoundingClientRect().bottom > node.getBoundingClientRect().top);
          window.wheelReadingPosition = { key: row.dataset.messageKey, top: row.getBoundingClientRect().top };
        }, { once: true, capture: true });
      });
      await page.mouse.wheel(0, delta);
      await expect.poll(() => page.evaluate(() => Boolean(window.wheelReadingPosition))).toBe(true);
      // Check the visual position, not scrollTop: measuring rows above the
      // viewport legitimately changes scrollTop while preserving what is read.
      await expect.poll(() => viewport(page).evaluate(node => {
        const { key, top } = window.wheelReadingPosition;
        const row = [...node.querySelectorAll('[data-message-key]')].find(item => item.dataset.messageKey === key);
        return row ? row.getBoundingClientRect().top - top : -10000;
      })).toBeCloseTo(-delta, 0);
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
      expect(settledOffsets.every(offset => Math.abs(offset + delta) < 1)).toBe(true);
      await expect(viewport(page)).toHaveAttribute('data-scroll-follow-paused', 'true');
    }
  } finally {
    await page.evaluate(() => clearInterval(window.streamingScrollTimer));
  }
  expect(Number(await page.locator('[data-rendered-message-count]').getAttribute('data-rendered-message-count'))).toBeLessThanOrEqual(60);
});

test('nested process messages stay visually anchored through reflow in both reading directions', async ({ page }) => {
  await page.route('**/api/config', route => route.fulfill({ json: {} }));
  await open(page);
  await page.evaluate(() => {
    window.streamFixture.prepend(200);
    window.streamFixture.beginTurn();
    for (let index = 0; index < 8; index++) {
      window.streamFixture.tool(`nested-${index}`, 'read_file', { file_path: `example-${index}.ts` });
      window.streamFixture.finishTool(`nested-${index}`, 'Synthetic file contents.\n'.repeat(20));
    }
  });
  await expect(page.locator('[data-virtualized-messages="true"]')).toHaveCount(1);
  await expect(page.locator('[data-tool-id^="nested-"] > div > button')).toHaveCount(8);
  await page.locator('[data-tool-id^="nested-"] > div > button[aria-expanded="false"]').evaluateAll(nodes => nodes.forEach(node => node.click()));
  await page.waitForTimeout(500);
  // Expansion may already leave the reader at the bottom, hiding the button.
  await page.locator('[data-tool-id="nested-7"] > div > button').press('End');
  await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
  await viewport(page).hover({ position: { x: 60, y: 300 } });
  for (const delta of [-240, 120, -120]) {
    await page.mouse.wheel(0, delta);
    await expect(viewport(page)).toHaveAttribute('data-scroll-follow-paused', 'true');
    await page.waitForTimeout(350);
    const anchor = await viewport(page).evaluate(node => {
      const edge = node.getBoundingClientRect().top;
      const rows = [...node.querySelectorAll('.chat-message .chat-message[data-message-key]')]
        .filter(item => item.getBoundingClientRect().height > 0 && !item.closest('[inert]'));
      const row = rows.find(item => item.getBoundingClientRect().bottom > edge);
      if (!row) throw new Error('Expected a visible nested process message');
      const earlier = rows.find(item => item.getBoundingClientRect().bottom < edge);
      if (!earlier) throw new Error('Expected an earlier process message above the viewport');
      const spacer = document.createElement('div');
      spacer.dataset.reflowProbe = '';
      earlier.append(spacer);
      return { key: row.dataset.messageKey, y: row.getBoundingClientRect().top };
    });
    for (const height of [180, 60, 0]) {
      // A delayed tool body/media measurement can change a sibling's height
      // inside the same virtual row while the reader is inspecting another.
      await page.locator('[data-reflow-probe]').last().evaluate((node, height) => { node.style.height = `${height}px`; }, height);
      await page.waitForTimeout(200);
      expect(await page.locator('[data-reflow-probe]').evaluate(node => node.getBoundingClientRect().height)).toBeCloseTo(height, 3);
      const y = await viewport(page).evaluate((node, key) => [...node.querySelectorAll('[data-message-key]')]
        .find(item => item.dataset.messageKey === key)?.getBoundingClientRect().top, anchor.key);
      expect(y).toBeCloseTo(anchor.y, 0);
    }
    await page.locator('[data-reflow-probe]').evaluate(node => node.remove());
  }
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
  const turn = page.locator('[data-turn-process-header] button').last();
  await expect(turn).toHaveAttribute('aria-expanded', 'false');
  await expect(viewport(page)).toHaveAttribute('data-scroll-follow-paused', 'true');
  await turn.click();
  const completedProcess = page.locator('[data-process-block] > button');
  await expect(completedProcess).toHaveAttribute('aria-expanded', 'false');
  await completedProcess.click();
  await expect(completedProcess).toHaveAttribute('aria-expanded', 'true');
  await expect(thinking).toBeVisible();
  expect(Math.abs(await top(thinking) - readingTop)).toBeLessThan(2);
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

test('tool groups fold on new replies and retain inspected details and reader position when reopened', async ({ page }) => {
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
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  const body = page.locator('[data-process-block] > .chat-process-disclosure');
  await expect(body).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(() => body.evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(1);
  await expect(viewport(page)).toHaveAttribute('data-scroll-follow-paused', 'true');
  await group.click();
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(tool).toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(700);
  expect(Math.abs(await tool.evaluate(node => node.getBoundingClientRect().top) - readingY)).toBeLessThan(2);
  await page.evaluate(() => window.streamFixture.complete(5000));
  const turn = page.locator('[data-turn-process-header] button');
  await expect(turn).toHaveAttribute('aria-expanded', 'false');
  await turn.click();
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await group.click();
  await expect(tool).toHaveAttribute('aria-expanded', 'false');
  await tool.click();
  await page.getByRole('button', { name: 'Back to latest' }).click();
  await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
  await expect(tool).toHaveAttribute('aria-expanded', 'true');
});

test('ongoing generation permits bidirectional wheels and repeated middle-step disclosures without jumps', async ({ page }) => {
  await page.route('**/api/config', route => route.fulfill({ json: {} }));
  await open(page);
  await page.evaluate(() => {
    window.streamFixture.prepend(200);
    window.streamFixture.beginTurn();
    for (let index = 0; index < 8; index++) {
      window.streamFixture.tool(`live-step-${index}`, 'read_file', { file_path: `example-${index}.ts` });
      window.streamFixture.finishTool(`live-step-${index}`, 'Synthetic step output.\n'.repeat(20));
    }
    window.streamFixture.text('Current streamed paragraph.\n\n'.repeat(20));
  });
  const group = page.locator('[data-process-block] > button');
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  // Wait for the initial typewriter tail before requesting a large downward
  // wheel; an unfinished reply can still make that target exceed native bounds.
  await expect(page.getByText('Current streamed paragraph.', { exact: true })).toHaveCount(20);
  await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
  await page.evaluate(() => {
    let tokens = 0;
    window.streamingScrollTimer = setInterval(() => window.streamFixture.text(
      'Current streamed paragraph.\n\n'.repeat(20) + 'New token '.repeat(++tokens)), 30);
  });
  const holdTrigger = async (button, action) => {
    await expect(button).toBeInViewport();
    await button.evaluate(node => {
      window.triggerPositions = [];
      window.sampleTrigger = true;
      const sample = () => {
        if (!window.sampleTrigger) return;
        const viewport = document.querySelector('[data-chat-search-surface]');
        window.triggerPositions.push({ y: node.getBoundingClientRect().top, top: viewport.scrollTop, height: viewport.scrollHeight, key: viewport.dataset.readingAnchorKey });
        requestAnimationFrame(sample);
      };
      sample();
    });
    await action();
    await page.waitForTimeout(600);
    const positions = await page.evaluate(() => { window.sampleTrigger = false; return window.triggerPositions; });
    expect(positions.length).toBeGreaterThan(5);
    const ys = positions.map(position => position.y);
    expect(Math.max(...ys) - Math.min(...ys), JSON.stringify({ first: positions.slice(0, 6), last: positions.slice(-6) })).toBeLessThan(2);
  };
  const wheel = async delta => {
    await viewport(page).hover({ position: { x: 60, y: 300 } });
    await viewport(page).evaluate(node => { window.liveReadingPosition = null; node.addEventListener('wheel', () => {
      const row = [...node.querySelectorAll('.chat-message[data-message-key]')]
        .find(item => item.getBoundingClientRect().bottom > node.getBoundingClientRect().top);
      window.liveReadingPosition = { key: row.dataset.messageKey, y: row.getBoundingClientRect().top };
    }, { once: true, capture: true }); });
    await page.mouse.wheel(0, delta);
    await expect.poll(() => viewport(page).evaluate(node => {
      const anchor = window.liveReadingPosition;
      const row = [...node.querySelectorAll('[data-message-key]')].find(item => item.dataset.messageKey === anchor?.key);
      return row ? row.getBoundingClientRect().top - anchor.y : NaN;
    })).toBeCloseTo(-delta, 0);
    await expect(viewport(page)).toHaveAttribute('data-scroll-follow-paused', 'true');
  };
  const revealTrigger = async button => {
    const delta = await button.evaluate(node => node.getBoundingClientRect().top
      - document.querySelector('[data-chat-search-surface]').getBoundingClientRect().top - 250);
    // Integral wheel notches also map to integral device pixels at Windows'
    // common 125/150/175% display scales. The target need only be near center.
    if (Math.abs(delta) > 20) await wheel(Math.round(delta / 40) * 40);
  };
  try {
    await wheel(-520);
    await revealTrigger(group);
    await holdTrigger(group, () => group.click());
    const middle = page.locator('[data-tool-id="live-step-3"] > div > button');
    await expect(middle).toHaveAttribute('aria-expanded', 'false');
    await revealTrigger(middle);
    await holdTrigger(middle, () => middle.click());
    for (const delta of [-80, 160, -120, 80]) await wheel(delta);
    await revealTrigger(middle);
    await holdTrigger(middle, () => middle.click());
    const next = page.locator('[data-tool-id="live-step-4"] > div > button');
    await revealTrigger(next);
    await holdTrigger(next, () => next.click());
    for (const delta of [120, -160, 80]) await wheel(delta);
    expect(await viewport(page).locator('.chat-message').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).contentVisibility === 'visible'))).toBe(true);
    await page.getByRole('button', { name: 'Back to latest' }).click();
    await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
    await page.waitForTimeout(200);
    await expect.poll(() => distance(viewport(page))).toBeLessThan(3);
  } finally {
    await page.evaluate(() => { window.sampleTrigger = false; clearInterval(window.streamingScrollTimer); });
  }
});

test('completion closes all inspected historical and current processes once', async ({ page }) => {
  await page.route('**/api/config', route => route.fulfill({ json: {} }));
  await open(page);
  await page.evaluate(() => {
    window.streamFixture.beginTurn('previous-user');
    window.streamFixture.tool('history-step', 'read_file', { file_path: 'previous.ts' });
    window.streamFixture.finishTool('history-step', 'Previous step details.');
    window.streamFixture.text('Previous answer.');
    window.streamFixture.complete(2000);
  });
  await expect(page.locator('[data-turn-process-header] button')).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => {
    window.streamFixture.beginTurn('next-user');
    window.streamFixture.tool('current-step', 'read_file', { file_path: 'current.ts' });
    window.streamFixture.finishTool('current-step', 'Current step details.');
    window.streamFixture.text('Current visible answer.\n\n'.repeat(20));
    let tokens = 0;
    window.streamingScrollTimer = setInterval(() => window.streamFixture.text(
      'Current visible answer.\n\n'.repeat(20) + 'New token '.repeat(++tokens)), 30);
  });
  try {
    const headers = page.locator('[data-turn-process-header] button');
    const groups = page.locator('[data-process-block] > button');
    await page.locator('[data-turn-index="24"]').click();
    await headers.first().click(); await groups.first().click();
    const oldTool = page.locator('[data-tool-id="history-step"] > div > button');
    await oldTool.click();
    await page.locator('[data-turn-index="25"]').click();
    await groups.last().click();
    await page.locator('[data-tool-id="current-step"] > div > button').click();
    await expect(headers).toHaveCount(2);
    await expect(page.locator('[data-turn-process-header] button[aria-expanded="true"]')).toHaveCount(2);
    await expect(page.locator('[data-process-block] > button[aria-expanded="true"]')).toHaveCount(2);
    await page.waitForTimeout(350);
    await page.evaluate(() => { clearInterval(window.streamingScrollTimer); window.streamFixture.complete(5000); });
    await expect(page.locator('[data-turn-process-header] button[aria-expanded="true"]')).toHaveCount(0);
    await expect(page.locator('[data-process-block] > button[aria-expanded="true"]')).toHaveCount(0);
    await expect(viewport(page)).toContainText('Current visible answer.');
    await expect(viewport(page)).toHaveAttribute('data-scroll-follow-paused', 'true');
    await page.locator('[data-turn-index="24"]').click();
    await headers.first().click();
    await expect(groups.first()).toHaveAttribute('aria-expanded', 'false');
    await groups.first().click();
    await expect(oldTool).toHaveAttribute('aria-expanded', 'false');
    await oldTool.click();
    await page.evaluate(() => window.streamFixture.complete(5000));
    await expect(headers.first()).toHaveAttribute('aria-expanded', 'true');
    await expect(oldTool).toHaveAttribute('aria-expanded', 'true');
  } finally { await page.evaluate(() => clearInterval(window.streamingScrollTimer)); }
});
