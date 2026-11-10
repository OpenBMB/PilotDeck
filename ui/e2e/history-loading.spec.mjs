import { test, expect } from '@playwright/test';
const viewport = page => page.locator('[data-chat-search-surface]');
const base = { provider: 'pilotdeck', sessionId: 'a', timestamp: '2026-09-01T00:00:00Z' };
const history = count => Array.from({ length: count }, (_, i) => [
  { ...base, id: `u-${i}`, runId: `r-${i}`, kind: 'text', role: 'user', content: `Question ${i}` },
  { ...base, id: `a-${i}`, runId: `r-${i}`, kind: 'text', role: 'assistant', content: `Answer ${i}.\n\nA paragraph to keep the transcript readable.` },
]).flat();
async function serve(page, messages, { failOlder = false } = {}) {
  const requests = [];
  let active = 0, maxActive = 0;
  await page.route('**/api/sessions/*/messages*', async route => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get('cursor');
    const direction = url.searchParams.get('direction');
    const includeFromId = url.searchParams.get('includeFromId');
    requests.push({ cursor, direction, includeFromId });
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 150));
    active--;
    if (cursor && failOlder) { failOlder = false; return route.abort('failed'); }
    let end = cursor ? messages.findIndex(m => m.id === cursor.slice(7)) : messages.length;
    let start = direction === 'backward' ? Math.max(0, end - Number(url.searchParams.get('limit') || 100)) : 0;
    if (direction === 'backward' && !cursor && includeFromId) {
      const anchor = messages.findIndex(message => message.id === includeFromId);
      if (anchor >= 0) start = Math.min(start, anchor);
    }
    while (start > 0 && messages[start].role !== 'user') start--;
    await route.fulfill({ json: { messages: messages.slice(start, end), total: messages.length,
      hasMore: start > 0, ...(start ? { nextCursor: `before:${messages[start].id}` } : {}) } });
  });
  return { requests, get maxActive() { return maxActive; } };
}
const loadedCount = page => page.evaluate(() => window.historyFixture.store.getMessages('a').length);
async function reachTop(page) {
  await viewport(page).hover({ position: { x: 100, y: 180 } });
  await page.mouse.wheel(0, -100000);
}

test('upward browsing automatically prepends history, preserves the reading anchor and bounds the DOM', async ({ page }) => {
  const server = await serve(page, history(220));
  await page.goto('/e2e/fixtures/history-loading.html');
  await expect.poll(() => loadedCount(page)).toBe(100);
  await expect(page.getByRole('button', { name: /Load (all|earlier) messages/ })).toHaveCount(0);
  expect(server.requests[0].direction).toBe('backward');
  for (const count of [200, 300, 400, 440]) {
    await reachTop(page);
    await expect(page.getByText('Loading older messages...', { exact: true })).toBeVisible();
    const anchor = await viewport(page).evaluate(node => {
      const top = node.getBoundingClientRect().top;
      const row = [...node.querySelectorAll('[data-message-key]')].find(row => row.getBoundingClientRect().bottom > top + 60);
      return { key: row.dataset.messageKey, y: row.getBoundingClientRect().top };
    });
    await expect.poll(() => loadedCount(page)).toBe(count);
    await expect.poll(() => viewport(page).evaluate((node, key) => [...node.querySelectorAll('[data-message-key]')]
      .find(row => row.dataset.messageKey === key)?.getBoundingClientRect().top ?? -10000, anchor.key)).toBeCloseTo(anchor.y, 0);
  }
  expect(server.maxActive).toBe(1);
  await expect(page.locator('[data-history-sentinel]')).toHaveCount(0);
  const rendered = Number(await page.locator('[data-total-message-count]').getAttribute('data-rendered-message-count'));
  expect(rendered).toBeLessThan(80);
  const ids = await page.evaluate(() => window.historyFixture.store.getMessages('a').map(m => m.id));
  expect(ids).toEqual(history(220).map(m => m.id));
  await page.getByRole('button', { name: 'Back to latest' }).click();
  await expect(page.getByText('Question 219', { exact: true })).toBeVisible();
  await expect.poll(() => viewport(page).evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(3);
  expect(await page.locator('[data-chat-response-reserved-space]').count()).toBe(0);
});

test('reentering paginated versioned history never appends old replies without their user turns', async ({ page }) => {
  const messages = history(120).map(message => message.role === 'assistant' ? {
    ...message, isFinal: true,
    timeline: { version: 1, turnId: message.runId, id: 'reply', order: 0, revision: 1 },
  } : message);
  await serve(page, messages);
  await page.goto('/e2e/fixtures/history-loading.html');
  await expect.poll(() => loadedCount(page)).toBe(100);
  await reachTop(page);
  await expect.poll(() => loadedCount(page)).toBe(200);
  await page.getByRole('button', { name: 'Back to latest' }).click();
  await expect(page.getByText('Question 119', { exact: true })).toBeVisible();
  const expected = messages.slice(-100).map(message => message.content);
  const requests = [];
  page.on('request', request => {
    if (request.url().includes('/api/sessions/a/messages')) requests.push(request.url());
  });
  await page.evaluate(() => window.historyFixture.setSession(1));
  await expect.poll(() => page.evaluate(() => window.historyFixture.chat.currentSessionId)).toBe('b');
  await page.evaluate(() => window.historyFixture.setSession(0));
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.historyFixture.chat.isLoadingSessionMessages)).toBe(false);
  expect(await page.evaluate(() => window.historyFixture.store.getMessages('a').map(message => message.content))).toEqual(expected);
  await expect(page.getByText('Question 119', { exact: true })).toBeVisible();
  await reachTop(page);
  await expect.poll(() => loadedCount(page)).toBe(200);
  expect(await page.evaluate(() => window.historyFixture.store.getMessages('a').map(message => message.content)))
    .toEqual(messages.slice(-200).map(message => message.content));
});

test('reentry preserves an older reading anchor while refreshing newly appended turns', async ({ page }) => {
  const messages = history(220);
  const server = await serve(page, messages);
  await page.goto('/e2e/fixtures/history-loading.html');
  await expect.poll(() => loadedCount(page)).toBe(100);
  await reachTop(page);
  await expect.poll(() => loadedCount(page)).toBe(200);
  await page.mouse.wheel(0, -2500);
  await expect.poll(() => viewport(page).getAttribute('data-reading-anchor-key')).toMatch(/(?:u|a)-1[23456]\d/);
  // A native wheel can span multiple compositor frames. Save a settled reading
  // position, not an intermediate row that the same gesture is still leaving.
  let previousPosition;
  let stableSamples = 0;
  await expect.poll(async () => {
    const position = await viewport(page).evaluate(node => {
      const key = node.dataset.readingAnchorKey;
      const row = [...node.querySelectorAll('[data-message-key]')].find(row => row.dataset.messageKey === key);
      return row ? JSON.stringify([key, node.scrollTop, row.getBoundingClientRect().top]) : null;
    });
    stableSamples = position && position === previousPosition ? stableSamples + 1 : 0;
    previousPosition = position;
    return stableSamples;
  }, { intervals: [50] }).toBeGreaterThanOrEqual(3);
  const before = await viewport(page).evaluate(node => {
    const key = node.dataset.readingAnchorKey;
    const row = [...node.querySelectorAll('[data-message-key]')].find(row => row.dataset.messageKey === key);
    return { key, y: row.getBoundingClientRect().top };
  });
  await page.evaluate(() => window.historyFixture.setSession(1));
  await expect.poll(() => page.evaluate(() => window.historyFixture.chat.currentSessionId)).toBe('b');
  messages.push(...history(225).slice(440));
  await page.evaluate(() => window.historyFixture.setSession(0));
  await expect.poll(() => page.evaluate(() => window.historyFixture.chat.currentSessionId)).toBe('a');
  await expect.poll(() => page.evaluate(() => window.historyFixture.chat.isLoadingSessionMessages)).toBe(false);
  expect(server.requests.at(-1).includeFromId).toBe('u-120');
  await expect(viewport(page).locator(`[data-message-key="${before.key}"]`)).toBeVisible();
  await expect.poll(() => viewport(page).locator(`[data-message-key="${before.key}"]`).evaluate(row => row.getBoundingClientRect().top)).toBeCloseTo(before.y, 0);
  expect(await page.evaluate(() => window.historyFixture.store.getMessages('a').at(-1).content)).toContain('Answer 224');
});

test('a long completed turn retains every step and retry recovers without repeated messages', async ({ page }) => {
  const messages = history(80);
  messages.push({ ...base, id: 'long-user', runId: 'long', kind: 'text', role: 'user', content: 'Inspect all steps' });
  for (let i = 0; i < 130; i++) messages.push({ ...base, id: `tool-${i}`, runId: 'long', kind: 'tool_use', toolId: `tool-${i}`,
    toolName: 'read_file', toolInput: { file_path: `example-${i}.txt` } },
    { ...base, id: `result-${i}`, runId: 'long', kind: 'tool_result', toolId: `tool-${i}`, content: 'Read the file' });
  messages.push({ ...base, id: 'final', runId: 'long', kind: 'text', role: 'assistant', content: 'All steps were checked.' });
  await serve(page, messages, { failOlder: true });
  await page.goto('/e2e/fixtures/history-loading.html');
  await expect.poll(() => loadedCount(page)).toBe(262);
  await expect(page.getByText('Inspect all steps', { exact: true })).toBeVisible();
  await reachTop(page);
  await expect(page.getByRole('alert')).toContainText('Unable to load earlier messages.');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => loadedCount(page)).toBe(362);
  const ids = await page.evaluate(() => window.historyFixture.store.getMessages('a').map(m => m.id));
  expect(new Set(ids).size).toBe(ids.length);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('offscreen automatic folding invalidates expanded heights and leaves no phantom tail', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=160');
  await expect(page.getByText('Question 159', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const fixture = window.streamFixture;
    fixture.beginTurn();
    for (let i = 0; i < 6; i++) {
      fixture.text(`Intermediate report ${i}.\n\n`.repeat(15));
      fixture.tool(`inspect-${i}`);
      fixture.finishTool(`inspect-${i}`);
    }
    fixture.think('Checking the final details.\n\n'.repeat(30));
  });
  await expect(page.locator('[data-thinking-state]')).toBeVisible();
  await expect.poll(() => viewport(page).evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(3);
  await viewport(page).hover({ position: { x: 100, y: 200 } });
  await page.mouse.wheel(0, -12000);
  await expect(page.locator('[data-thinking-state]')).toHaveCount(0);
  await page.evaluate(() => { window.streamFixture.text('Final checked result.'); window.streamFixture.complete(); });
  await page.getByRole('button', { name: 'Back to latest' }).click();
  await expect(page.getByText('Final checked result.', { exact: true })).toBeVisible();
  await expect(page.locator('[data-chat-response-reserved-space]')).toHaveCount(0);
  await expect.poll(async () => {
    const outer = await viewport(page).boundingBox();
    const answer = await page.getByText('Final checked result.', { exact: true }).boundingBox();
    return outer.y + outer.height - answer.y - answer.height;
  }).toBeLessThan(120);
  await expect(page.locator('[data-turn-process-header] button').last()).toHaveAttribute('aria-expanded', 'false');
});

test('search/fetch summaries and recorded time remain correct after reload and language changes', async ({ page }) => {
  const timing = { startedAt: '2026-09-01T00:00:00Z', completedAt: '2026-09-01T00:01:20Z', finishReason: 'completed' };
  const messages = [{ ...base, id: 'u', kind: 'text', role: 'user', content: 'Check the web', turnTiming: timing }];
  for (let i = 0; i < 6; i++) messages.push({ ...base, id: `fetch-${i}`, kind: 'tool_use', toolId: `fetch-${i}`, toolName: 'web_fetch', toolInput: { url: `https://example.com/${i}` } },
    { ...base, id: `result-${i}`, kind: 'tool_result', toolId: `fetch-${i}`, content: 'Page received' });
  messages.push({ ...base, id: 'search', kind: 'tool_use', toolId: 'search', toolName: 'web_search', toolInput: { query: 'Example' } },
    { ...base, id: 'search-result', kind: 'tool_result', toolId: 'search', content: 'Found' },
    { ...base, id: 'final', kind: 'text', role: 'assistant', content: 'Web results checked.', timestamp: '2026-09-01T00:00:32Z' });
  await serve(page, messages);
  await page.goto('/e2e/fixtures/history-loading.html');
  await expect(page.getByText('Processed 1m 20s', { exact: true })).toBeVisible();
  await page.locator('[data-turn-process-header] button').click();
  await expect(page.locator('[data-process-block] > button')).toContainText('Searched 1 time Fetched 6 pages');
  await page.evaluate(() => window.historyFixture.setLanguage('zh-CN'));
  await expect(page.getByText('已处理 1 分 20 秒', { exact: true })).toBeVisible();
  await expect(page.locator('[data-process-block] > button')).toContainText('已搜索 1 次 已读取 6 个网页');
  await page.reload();
  await expect(page.getByText('Processed 1m 20s', { exact: true })).toBeVisible();
});

for (const timingHost of ['status', 'user']) for (const reason of ['aborted_streaming', 'model_error']) test(`restored ${reason} with timing on ${timingHost} keeps steered work inspectable`, async ({ page }) => {
  // The history reader can attach bounds to a status preceding accepted_input.
  // Its run starts before the user timestamp, so clock-only ownership is wrong.
  const turn = { ...base, turnId: 'restored-terminal-run', runId: 'restored-terminal-run' };
  const turnTiming = { startedAt: '2026-09-01T00:00:00Z', completedAt: '2026-09-01T00:01:20Z', finishReason: reason };
  const messages = [
    { ...base, id: 'earlier-user', kind: 'text', role: 'user', content: 'An earlier request', turnId: 'earlier' },
    { ...base, id: 'earlier-answer', kind: 'text', role: 'assistant', content: 'An earlier answer', turnId: 'earlier' },
    ...(timingHost === 'status' ? [{ ...turn, id: 'timed-status', kind: 'status', text: 'Checkpoint saved', turnTiming }] : []),
    { ...turn, id: 'u', kind: 'text', role: 'user', content: 'Inspect partial work', timestamp: '2026-09-01T00:00:00.200Z',
      ...(timingHost === 'user' ? { turnTiming } : {}) },
    { ...turn, id: 'before-steer', kind: 'text', role: 'assistant', content: 'Work before guidance.', timestamp: '2026-09-01T00:00:10Z' },
    { ...turn, id: 'steer', kind: 'text', role: 'user', content: 'Include the redirected page', isSteer: true, timestamp: '2026-09-01T00:00:20Z' },
    { ...turn, id: 'call', kind: 'tool_use', toolId: 'call', toolName: 'web_fetch', toolInput: { url: 'https://example.com' }, timestamp: '2026-09-01T00:00:30Z' },
    { ...turn, id: 'partial', kind: 'text', role: 'assistant', content: 'Partial result remains available.', timestamp: '2026-09-01T00:00:40Z' },
  ];
  await serve(page, messages);
  await page.goto('/e2e/fixtures/history-loading.html');
  await expect(page.getByText(reason === 'model_error' ? 'Process failed' : 'Process stopped', { exact: true }).last()).toBeVisible();
  const header = page.locator('[data-turn-process-header] button').last();
  await expect(header).toHaveAttribute('aria-expanded', reason === 'model_error' ? 'true' : 'false');
  if (reason.startsWith('aborted')) {
    const notice = page.getByText('The user stopped the conversation', { exact: true });
    await expect(notice).toHaveCount(1);
    await expect(notice).toBeVisible();
    const beforeGuidance = page.locator('[data-turn-process-header] button').nth(-2);
    await expect(beforeGuidance).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText('Work before guidance.', { exact: true })).not.toBeVisible();
    await beforeGuidance.click();
    await expect(page.getByText('Work before guidance.', { exact: true })).toBeVisible();
    await beforeGuidance.click();
    await header.click();
  } else {
    await expect(page.getByText('The user stopped the conversation', { exact: true })).toHaveCount(0);
  }
  await expect(page.getByText('Partial result remains available.', { exact: true })).toBeVisible();
  await expect(page.getByText('Calling model...', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-process-live="true"]')).toHaveCount(0);
});

for (const code of [null, 'tool_execution_failed', 'permission_denied']) test(`a single fetch folds with completed work and retains its result (${code ?? 'success'})`, async ({ page }) => {
  const messages = [{ ...base, id: 'user', kind: 'text', role: 'user', content: 'Check a page', turnTiming: {
    startedAt: '2026-09-01T00:00:00Z', completedAt: '2026-09-01T00:00:08Z', finishReason: 'completed' } },
  { ...base, id: 'fetch', kind: 'tool_use', toolId: 'fetch', toolName: 'web_fetch', toolInput: { url: 'https://example.com/page' } },
  { ...base, id: 'result', kind: 'tool_result', toolId: 'fetch', content: code ? 'HTTP 403: Permission denied; the remote site requires authentication.' : 'Page received.', isError: Boolean(code), errorCode: code },
  { ...base, id: 'final', kind: 'text', role: 'assistant', content: 'The final response.' }];
  await serve(page, messages);
  await page.goto('/e2e/fixtures/history-loading.html');
  await expect(page.getByText('The final response.', { exact: true })).toBeVisible();
  const turn = page.locator('[data-turn-process-header] button');
  await expect(turn).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-tool-id="fetch"]')).toHaveCount(0);
  await turn.click();
  const process = page.locator('[data-process-block] > button');
  await expect(process).toHaveText('Fetched 1 page');
  await expect(process).toHaveAttribute('aria-expanded', 'false');
  await process.click();
  await expect(page.getByRole('button', { name: `${code ? 'Fetch failed' : 'Fetched'} https://example.com/page`, exact: true })).toBeVisible();
  await turn.click();
  await expect(turn).toHaveAttribute('aria-expanded', 'false');
  const closedProcess = page.locator('[data-turn-process-member]');
  await expect(closedProcess).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(async () => (await closedProcess.boundingBox()).height).toBeLessThan(1);
  await expect(page.getByText('The final response.', { exact: true })).toBeVisible();
});
