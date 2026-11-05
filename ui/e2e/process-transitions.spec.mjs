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

async function expectSmoothOpen(page) {
  await expect.poll(() => page.evaluate(() => window.transitionSamples.at(-1))).toBeGreaterThan(0);
  await page.waitForTimeout(520);
  const heights = await page.evaluate(() => window.transitionSamples);
  expect(heights.some(height => height > 0 && height < Math.max(...heights) - 1)).toBe(true);
}

async function watchWidths(page) {
  await expect(page.locator('[data-chat-scroll-content]')).toBeAttached();
  await page.evaluate(() => {
    window.widthSamples = [];
    const end = performance.now() + 650;
    const sample = () => {
      const viewport = document.querySelector('[data-chat-search-surface]');
      const content = document.querySelector('[data-chat-scroll-content]').getBoundingClientRect();
      window.widthSamples.push([viewport.clientWidth, content.width, content.left, document.documentElement.scrollWidth]);
      if (performance.now() < end) requestAnimationFrame(sample);
    };
    sample();
  });
}

async function expectStableWidths(page) {
  await page.waitForTimeout(680);
  const samples = await page.evaluate(() => window.widthSamples);
  for (let index = 0; index < 4; index++) {
    const values = samples.map(sample => sample[index]);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(1);
  }
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
  const runHeader = page.locator('[data-turn-process-header] button');
  await expect(runHeader).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('First visible progress reply.', { exact: true })).not.toBeInViewport();
  await expect(page.getByText('Final visible answer.', { exact: true })).toBeVisible();
  await runHeader.click();
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
  await expect(page.getByRole('button', { name: /Next step Continue 已回答/ })).toHaveCount(0);
  await page.locator('[data-turn-process-header] button').click();
  await page.locator('[data-question-tool] > button').click();
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

test('completion smoothly folds every intermediate process into the single measured turn header', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  await page.evaluate(() => { window.streamFixture.beginTurn(); window.streamFixture.think('Inspect the first step.'); });
  await page.evaluate(() => { window.streamFixture.tool(); window.streamFixture.finishTool(); window.streamFixture.text('Visible progress reply.'); });
  await expect(page.getByText('Visible progress reply.', { exact: true })).toBeVisible();
  await page.getByText('Visible progress reply.', { exact: true }).evaluate(node => { window.progressProse = node; });
  await page.evaluate(() => { window.streamFixture.tool('second'); window.streamFixture.finishTool('second'); window.streamFixture.think('Final checks.\n\n'.repeat(20)); });
  const header = page.locator('[data-turn-process-header] button');
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  const regions = page.locator('[data-turn-process-member]');
  await expect(regions).toHaveCount(2);
  await regions.first().evaluate(node => { window.originalRunRegion = node; });
  await watchHeight(page, '[data-turn-process-region]');
  await page.evaluate(() => { window.streamFixture.text('Final answer stays visible.'); window.streamFixture.complete(29000); });
  await expect(header).toHaveText('Processed 29s');
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(regions).toHaveCount(3);
  await expectSmoothClose(page);
  await expect.poll(() => regions.evaluateAll(nodes => nodes.reduce((height, node) => height + node.getBoundingClientRect().height, 0))).toBe(0);
  expect(await regions.first().evaluate(node => node === window.originalRunRegion)).toBe(true);
  expect(await page.getByText('Visible progress reply.', { exact: true }).evaluate(node => node === window.progressProse)).toBe(true);
  await expect(page.getByText('Visible progress reply.', { exact: true })).not.toBeInViewport();
  await expect(page.getByText('Final answer stays visible.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Used https:\/\/example.com/ })).toHaveCount(0);
  const controlIds = (await header.getAttribute('aria-controls')).split(' ');
  expect(controlIds).toHaveLength(3);
  await page.evaluate(() => window.streamFixture.setLanguage('zh-CN'));
  await expect(header).toHaveText('已处理 29 秒');
  await page.screenshot({ path: test.info().outputPath('turn-completed-collapsed-light.png'), animations: 'disabled' });
  await page.evaluate(() => window.streamFixture.setAppearance('default', true));
  await page.screenshot({ path: test.info().outputPath('turn-completed-collapsed-dark.png'), animations: 'disabled' });
  await header.click();
  await expect(page.locator('[data-process-block] > button')).toHaveCount(2);
  await expect(page.locator('[data-process-block] > button').first()).toBeVisible();
  await expect(page.locator('[data-process-block] > button').last()).toBeVisible();
  await expect(page.getByText('Visible progress reply.', { exact: true })).toBeVisible();
  expect(await regions.evaluateAll(nodes => nodes.map(node => node.hasAttribute('data-turn-process-prose') ? 'prose' : 'work'))).toEqual(['work', 'prose', 'work']);
  await page.evaluate(() => window.streamFixture.beginTurn('next-user'));
  await expect(header.first()).toHaveAttribute('aria-expanded', 'true');
});

test('nested work and tool details animate both ways without changing conversation width', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 500 });
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  await page.evaluate(() => {
    window.streamFixture.beginTurn();
    window.streamFixture.tool('shell', 'Bash', { command: 'echo ' + 'wide-command-'.repeat(200), description: 'Inspect output' });
    window.streamFixture.finishTool('shell', 'output line\n'.repeat(60));
    window.streamFixture.text('Final response.'); window.streamFixture.complete(3000);
  });
  const run = page.locator('[data-turn-process-header] button');
  const block = page.locator('[data-process-block] > button');
  for (const theme of ['default', 'mint']) {
    await page.evaluate(theme => window.streamFixture.setAppearance(theme, theme === 'mint'), theme);
    await watchWidths(page);
    await watchHeight(page, '[data-turn-process-member]');
    await run.click();
    await expectSmoothOpen(page); await expectStableWidths(page);

    await watchWidths(page); await watchHeight(page, '[data-process-block] > .chat-process-disclosure');
    await block.click();
    await expectSmoothOpen(page); await expectStableWidths(page);
    const tool = page.locator('[data-tool-id="shell"] button').first();
    const body = '[data-tool-id="shell"] > .chat-process-disclosure';
    await watchWidths(page); await watchHeight(page, body);
    await tool.click();
    await expectSmoothOpen(page); await expectStableWidths(page);
    await expect(page.locator('[data-chat-search-surface]')).toHaveCSS('scrollbar-gutter', 'stable');
    expect(await page.locator('[data-chat-search-surface]').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    const details = page.getByRole('region', { name: 'Tool details' });
    await expect(details).toHaveCSS('max-height', '320px');
    await page.getByRole('button', { name: 'Expand fully' }).click();
    await expect.poll(() => details.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(600);
    await page.getByRole('button', { name: 'Limit height' }).click();
    await expect(details).toHaveCSS('max-height', '320px');
    await page.screenshot({ path: test.info().outputPath(`tool-expanded-${theme}.png`), animations: 'disabled' });

    for (const [button, selector] of [[tool, body], [block, '[data-process-block] > .chat-process-disclosure'], [run, '[data-turn-process-member]']]) {
      await watchWidths(page); await watchHeight(page, selector); await button.click();
      await expectSmoothClose(page); await expectStableWidths(page);
    }
  }
});

test('multi-select answers survive history refresh in a compact full-width question tool', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  const questions = [
    { header: 'Scope', question: 'Which paths?', multiSelect: true, options: [{ label: 'A, B' }, { label: 'C' }, { label: 'D' }] },
    { header: 'Detail', question: 'How detailed?', options: [{ label: 'Summary' }, { label: 'Full' }] },
  ];
  await page.evaluate(questions => {
    window.streamFixture.beginTurn(); window.streamFixture.askQuestions(questions, 'Final selected route.');
  }, questions);
  const panel = page.locator('[data-question-panel]');
  const option = label => panel.getByRole('button', { name: new RegExp(` ${label}$`) });
  await option('A, B').click(); await option('C').click(); await option('D').click(); await option('C').click();
  expect(await option('A, B').evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(40);
  await panel.getByRole('button', { name: /Other/ }).click();
  await panel.getByRole('textbox').fill('Custom, answer');
  await panel.getByRole('button', { name: /Next/ }).click(); await option('Summary').click();
  await panel.getByRole('button', { name: /Back/ }).click();
  await expect(option('A, B')).toHaveAttribute('aria-pressed', 'true');
  await expect(option('D')).toHaveAttribute('aria-pressed', 'true');
  await expect(option('C')).toHaveAttribute('aria-pressed', 'false');
  await panel.getByRole('button', { name: /Next/ }).click();
  await page.screenshot({ path: test.info().outputPath('question-compact-options.png'), animations: 'disabled' });
  await panel.getByRole('button', { name: /Submit/ }).click();
  const history = await page.evaluate(() => window.streamFixture.getMessages());
  expect(history.find(message => message.kind === 'tool_result').toolUseResult.answers).toEqual({
    'Which paths?': ['A, B', 'D', 'Custom, answer'], 'How detailed?': 'Summary',
  });
  await page.route('**/api/sessions/scroll-fixture/messages*', route => route.fulfill({ json: { messages: history, total: history.length } }));
  await page.evaluate(() => window.streamFixture.refresh());
  const run = page.locator('[data-turn-process-header] button');
  await expect(run).toHaveAttribute('aria-expanded', 'false'); await run.click();
  const header = page.locator('[data-question-tool] > button');
  await expect(header).toContainText('Answered 2/2');
  await watchHeight(page, '[data-question-tool] > .chat-process-disclosure'); await header.click();
  await expectSmoothOpen(page);
  const card = page.locator('[data-question-transcript]');
  const tool = page.locator('[data-question-tool]');
  expect((await tool.boundingBox()).width - (await card.boundingBox()).width).toBeLessThan(24);
  expect(await card.getByRole('button').first().evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(36);
  await card.getByRole('button', { name: /Scope\s*A, B, D, Custom, answer/ }).click();
  await expect(card.locator('[data-answer-selected="true"]')).toHaveCount(3);
  await expect(card.getByText('A, B', { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('question-compact-transcript.png'), animations: 'disabled' });
});

test('todo acknowledgement has one animated checklist and shares the process rhythm', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  await page.evaluate(() => {
    window.streamFixture.beginTurn();
    window.streamFixture.tool('todo', 'TodoWrite', { markdown: '- [x] Inspect changes\n- [ ] Verify changes\n- [ ] Publish changes' });
    window.streamFixture.finishTool('todo', 'Todo list updated');
  });
  const todo = page.locator('[data-todo-tool] > button');
  await expect(todo).toHaveText('Todo list1/3 completed');
  await expect(page.getByText('Details', { exact: true })).toHaveCount(0);
  await watchHeight(page, '[data-todo-tool] > .chat-process-disclosure'); await todo.click(); await expectSmoothOpen(page);
  await expect(page.getByText('Inspect changes', { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('todo-compact-light.png'), animations: 'disabled' });
  await page.evaluate(() => { window.streamFixture.setAppearance('default', true); return window.streamFixture.setLanguage('zh-CN'); });
  await expect(todo).toContainText('待办事项');
  await page.screenshot({ path: test.info().outputPath('todo-compact-dark.png'), animations: 'disabled' });
  await watchHeight(page, '[data-todo-tool] > .chat-process-disclosure'); await todo.click(); await expectSmoothClose(page);
});

test('native task disclosures keep their content mounted through both transitions', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  await page.evaluate(() => {
    window.streamFixture.tool('tasks', 'TaskList', {});
    window.streamFixture.finishTool('tasks', Array.from({ length: 8 }, (_, index) => `#${index + 1}. [pending] Verify task ${index + 1}`).join('\n'));
  });
  const summary = page.locator('details > summary');
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await watchHeight(page, 'details > .chat-process-disclosure'); await summary.click(); await expectSmoothClose(page);
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await watchHeight(page, 'details > .chat-process-disclosure'); await summary.click(); await expectSmoothOpen(page);
  await expect(page.getByText('Verify task 8', { exact: true })).toBeVisible();
  await watchHeight(page, 'details > .chat-process-disclosure'); await summary.press('Enter'); await expectSmoothClose(page);
});

test('file generation shows live path and size before writing, then opens a bounded large-file preview', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  await page.evaluate(() => {
    window.streamFixture.beginTurn(); window.streamFixture.think('Review the implementation.');
    window.streamFixture.prepareFile('write-large', 0);
  });
  const preparing = page.locator('[data-file-input-status]');
  await expect(preparing).toHaveCount(1);
  await expect(preparing).toContainText('Generating file content');
  await preparing.evaluate(node => { window.preparingNode = node; });
  await watchWidths(page);
  await page.evaluate(() => window.streamFixture.prepareFile('write-large', 64 * 1024, 'src/example.ts'));
  await expect(preparing).toContainText('example.ts');
  await expect(preparing).toContainText('64.0 KB received');
  await expectStableWidths(page);
  expect(await preparing.evaluate(node => node === window.preparingNode)).toBe(true);
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await page.evaluate(() => { window.streamFixture.setAppearance('mint', true); return window.streamFixture.setLanguage('zh-CN'); });
  await expect(preparing).toContainText('正在生成文件内容');
  await expect(preparing).toContainText('已接收 64.0 KB');
  await page.screenshot({ path: test.info().outputPath('file-preparation-dark-zh.png'), animations: 'disabled' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await preparing.locator('svg').evaluate(node => getComputedStyle(node).animationName)).toBe('none');
  await page.evaluate(() => window.streamFixture.tool('write-large', 'write_file', {
    file_path: 'src/example.ts', content: Array.from({ length: 10_000 }, (_, index) => `// line ${index}`).join('\n'),
  }));
  await expect(preparing).toHaveCount(0);
  const tool = page.locator('[data-tool-id="write-large"]');
  await expect(tool).toHaveCount(1);
  await expect(tool.locator(':scope button').first()).toContainText('example.ts');
  await tool.locator(':scope button').first().click();
  await expect(tool.locator('[data-file-preview-line]')).toHaveCount(200);
  await expect(tool).toContainText('已显示 200/10000 行');
  await page.screenshot({ path: test.info().outputPath('large-file-preview-dark-zh.png'), animations: 'disabled' });
  await tool.getByRole('button', { name: '显示更多行' }).click();
  await expect(tool.locator('[data-file-preview-line]')).toHaveCount(400);
  await page.evaluate(() => { window.streamFixture.finishTool('write-large', 'Saved');
    window.streamFixture.text('File written successfully.'); window.streamFixture.complete(); });
  await expect(page.locator('[data-turn-process-header] button')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('File written successfully.', { exact: true })).toBeVisible();
});

test('file results wait for execution to stop and remain last when work is reopened', async ({ page }) => {
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  await page.evaluate(() => {
    window.streamFixture.beginTurn();
    window.streamFixture.tool('write', 'write_file', { file_path: 'report.txt', content: 'Synthetic report.' });
    window.streamFixture.finishTool('write', 'Written');
    window.streamFixture.text('Checking the generated report.');
    window.streamFixture.files('incomplete');
    window.streamFixture.tool('verify', 'run_command', { command: 'verify report.txt' });
    window.streamFixture.finishTool('verify', 'Verified');
  });
  const card = page.getByTestId('turn-changes-card');
  await expect(card).toHaveCount(0);
  await page.evaluate(() => window.streamFixture.complete(5000));
  await expect(card).toBeVisible();
  await expect(page.locator('[data-turn-process-header] button')).toHaveAttribute('aria-expanded', 'false');
  expect(await card.evaluate(node => {
    const work = [...document.querySelectorAll('[data-process-block]')].at(-1);
    return Boolean(work.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
      && !node.closest('[data-turn-process-region]');
  })).toBe(true);
  // A later final reply moves the one footer to the new tail, after all prose.
  await page.evaluate(() => { window.streamFixture.text('Report complete.'); window.streamFixture.complete(5000); });
  await expect(card).toHaveCount(1);
  await expect(card).toBeVisible();
  await expect(page.getByText('Report complete.', { exact: true })).toBeVisible();
  expect(await card.evaluate(node => Boolean([...document.querySelectorAll('[data-assistant-quote-source]')].at(-1)
    .compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  const turn = page.locator('[data-turn-process-header] button');
  await expect(turn).toHaveAttribute('aria-expanded', 'false');
  await turn.click();
  await expect(page.getByText('Checking the generated report.', { exact: true })).toBeVisible();
  await expect(card).toBeVisible();
  await turn.click();
  await expect(card).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('turn-file-footer.png'), animations: 'disabled' });
});
