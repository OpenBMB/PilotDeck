import { test, expect } from '@playwright/test';

// Reproduction for Issue #750: after a refresh, the tail of a long conversation
// pairs an earlier user prompt with the latest assistant reply until the reader
// scrolls through the whole history. The transcript shape mirrors the report:
// a completed turn with a long work tail, four accepted inputs that never
// produced a model call, then the final completed turn.
const base = { provider: 'pilotdeck', sessionId: 'a', timestamp: '2026-09-01T00:00:00Z' };

function transcript() {
  const messages = [];
  // Older filler turns (large enough to exceed the 100-message page budget).
  for (let turn = 0; turn < 8; turn++) {
    messages.push({ ...base, id: `u-old-${turn}`, runId: `r-old-${turn}`, turnId: `r-old-${turn}`, kind: 'text', role: 'user', content: `Filler question ${turn}` });
    for (let step = 0; step < 30; step++) {
      messages.push({ ...base, id: `w-old-${turn}-${step}`, runId: `r-old-${turn}`, turnId: `r-old-${turn}`, kind: 'text', role: 'assistant', content: `Filler work ${turn}/${step}\n\nSome prose to give the row measurable height.` });
    }
    messages.push({ ...base, id: `a-old-${turn}`, runId: `r-old-${turn}`, turnId: `r-old-${turn}`, kind: 'text', role: 'assistant', content: `Filler answer ${turn}.\n\nA paragraph so the fold has an output.` });
  }
  // Turn A: completed turn with a long work tail (the page budget cuts inside it).
  messages.push({ ...base, id: 'u-a', runId: 'r-a', turnId: 'r-a', kind: 'text', role: 'user', content: '怎么感觉又不动了，yolo-UAV' });
  for (let step = 0; step < 40; step++) {
    messages.push({ ...base, id: `w-a-${step}`, runId: 'r-a', turnId: 'r-a', kind: 'text', role: 'assistant', content: `Turn A work step ${step}\n\nAgentic reading and analysis paragraphs.` });
  }
  messages.push({ ...base, id: 'a-a', runId: 'r-a', turnId: 'r-a', kind: 'text', role: 'assistant', content: '这次不是卡死，是误会——系统其实挺健康的，给你捋一下' });
  // Four accepted inputs that never produced a model call.
  messages.push({ ...base, id: 'u-c', runId: 'r-c', turnId: 'r-c', kind: 'text', role: 'user', content: '现在是什么情况？' });
  messages.push({ ...base, id: 'u-d', runId: 'r-d', turnId: 'r-d', kind: 'text', role: 'user', content: '还在吗？' });
  messages.push({ ...base, id: 'u-e', runId: 'r-e', turnId: 'r-e', kind: 'text', role: 'user', content: '模型又不调用了？' });
  messages.push({ ...base, id: 'u-f', runId: 'r-f', turnId: 'r-f', kind: 'text', role: 'user', content: 'train 停了吗？' });
  // Final turn: completed.
  messages.push({ ...base, id: 'u-b', runId: 'r-b', turnId: 'r-b', kind: 'text', role: 'user', content: '整个系统出啥问题了，都不调用模型了，一直空跑时间？' });
  for (let step = 0; step < 12; step++) {
    messages.push({ ...base, id: `w-b-${step}`, runId: 'r-b', turnId: 'r-b', kind: 'text', role: 'assistant', content: `Turn B work step ${step}\n\nServer inspection details.` });
  }
  messages.push({ ...base, id: 'a-b', runId: 'r-b', turnId: 'r-b', kind: 'text', role: 'assistant', content: '查清楚了，问题不在模型端，而在今天11:23重启后的新版agent server' });
  return messages;
}

const pageKeys = () => page.evaluate(() => [...document.querySelectorAll('[data-message-key]')]
  .map(row => window.historyFixture.store.getMessages('a').find(() => true) && row.dataset.messageKey));

test('refresh pairs every tail reply with its own prompt', async ({ page }) => {
  const messages = transcript();
  await page.route('**/api/sessions/*/messages*', async route => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get('cursor');
    const direction = url.searchParams.get('direction');
    let end = cursor ? messages.findIndex(m => m.id === cursor.slice(7)) : messages.length;
    let start = direction === 'backward' ? Math.max(0, end - Number(url.searchParams.get('limit') || 100)) : 0;
    while (start > 0 && messages[start].role !== 'user') start--;
    await route.fulfill({ json: { messages: messages.slice(start, end), total: messages.length,
      hasMore: start > 0, ...(start ? { nextCursor: `before:${messages[start].id}` } : {}) } });
  });
  await page.goto('/e2e/fixtures/history-loading.html');
  await expect.poll(() => page.evaluate(() => window.historyFixture.store.getMessages('a').length)).toBeGreaterThan(100);
  await page.waitForTimeout(1200);

  // The store must have loaded the tail page with every user input of the tail.
  const contents = await page.evaluate(() => window.historyFixture.store.getMessages('a').map(m => m.content || ''));
  const users = contents.filter((_, index) => messages.slice(messages.length - contents.length)[index]?.role === 'user');
  expect(users.length).toBeGreaterThanOrEqual(6);

  // Every user bubble of the tail must be rendered, and each reply must sit
  // under its own prompt: turn A's answer after turn A's prompt, turn B's
  // answer after turn B's prompt, with no reply above its own prompt.
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-message-key]')]
    .map(row => {
      const text = row.textContent || '';
      if (text.includes('怎么感觉又不动了')) return 'userA';
      if (text.includes('现在是什么情况？')) return 'userC';
      if (text.includes('还在吗？')) return 'userD';
      if (text.includes('模型又不调用了')) return 'userE';
      if (text.includes('train 停了吗')) return 'userF';
      if (text.includes('整个系统出啥问题了')) return 'userB';
      if (text.includes('这次不是卡死')) return 'replyA';
      if (text.includes('查清楚了')) return 'replyB';
      return 'other';
    })
    .filter(token => token !== 'other'));
  expect(order).toContain('userA');
  expect(order).toContain('userC');
  expect(order).toContain('userD');
  expect(order).toContain('userE');
  expect(order).toContain('userF');
  expect(order).toContain('userB');
  expect(order.indexOf('replyA')).toBeGreaterThan(order.indexOf('userA'));
  expect(order.indexOf('replyA')).toBeLessThan(order.indexOf('userC'));
  expect(order.indexOf('replyB')).toBeGreaterThan(order.indexOf('userB'));
  expect(order.indexOf('replyB')).toBeGreaterThan(order.indexOf('userF'));
});
