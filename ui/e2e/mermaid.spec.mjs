import { test, expect } from '@playwright/test';

const flow = 'flowchart LR\n A[用户提问] --> B[Agent处理]\n B --> C[返回结果]';
const fenced = source => `\`\`\`mermaid\n${source}\n\`\`\``;
const diagrams = page => page.getByRole('img', { name: 'Mermaid diagram', exact: true });
async function respond(page, source) {
  await page.evaluate(text => { window.streamFixture.text(text); window.streamFixture.complete(); }, source);
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  // Self-hosted HTTP deployments do not expose secure-context-only UUID APIs.
  await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined }));
  await page.route('**/api/**', route => route.fulfill({ json: { config: {} } }));
  await page.goto('/e2e/fixtures/streaming-scroll.html?history=0');
  await page.waitForFunction(() => Boolean(window.streamFixture));
});

test('real chat diagrams wait for the stream, support source/copy and use independent SVG ids', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const message = fenced(flow) + '\n\n' + fenced('sequenceDiagram\n participant A as 用户\n participant B as Agent\n A->>B: 你好');
  await page.evaluate(text => window.streamFixture.text(text), message);
  await expect(page.locator('pre code.language-mermaid')).toHaveCount(2);
  await expect(diagrams(page)).toHaveCount(0);
  await page.evaluate(() => window.streamFixture.complete());
  await expect(diagrams(page)).toHaveCount(2);
  await expect(diagrams(page).first()).toContainText('用户提问');
  await expect(diagrams(page).nth(1)).toContainText('你好');
  const ids = await diagrams(page).locator('svg').evaluateAll(nodes => nodes.map(node => node.id));
  expect(new Set(ids).size).toBe(2);
  await page.getByRole('button', { name: 'Show source', exact: true }).first().click();
  await expect(page.locator('pre code.language-mermaid')).toHaveText(flow + '\n');
  await page.getByRole('button', { name: 'Copy code', exact: true }).first().click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(flow);
  await page.getByRole('button', { name: 'Show diagram', exact: true }).click();
  await expect(diagrams(page)).toHaveCount(2);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect.poll(() => diagrams(page).locator('svg').first().getAttribute('id')).not.toBe(ids[0]);
  await expect(diagrams(page)).toHaveCount(2);
  const darkId = await diagrams(page).locator('svg').first().getAttribute('id');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await expect.poll(() => diagrams(page).locator('svg').first().getAttribute('id')).not.toBe(darkId);
  await expect(diagrams(page)).toHaveCount(2);
});

test('invalid and oversized diagrams retain readable source without stray error graphics', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await respond(page, fenced('flowchart LR\n A[') + '\n\n' + fenced('x'.repeat(50_001)) + '\n\n' + fenced(flow));
  await expect(page.getByText('Unable to render this diagram. The source is shown below.', { exact: true })).toHaveCount(2);
  await expect(page.locator('pre code.language-mermaid')).toHaveCount(2);
  await expect(diagrams(page)).toHaveCount(1);
  await expect(page.locator('body > div[style*="visibility: hidden"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('diagram directives cannot enable executable HTML or click callbacks', async ({ page }) => {
  await page.evaluate(() => { window.mermaidAttack = () => { window.mermaidAttackExecuted = true; }; });
  await respond(page, fenced('%%{init: {"securityLevel":"loose", "htmlLabels":true}}%%\nflowchart LR\n A["<img src=x onerror=mermaidAttack()>"] --> B[Safe]\n click B mermaidAttack'));
  await expect(diagrams(page)).toHaveCount(1);
  await expect(diagrams(page).locator('script, foreignObject, img, [onclick], [onerror], a')).toHaveCount(0);
  await diagrams(page).getByText('Safe', { exact: true }).click();
  expect(await page.evaluate(() => window.mermaidAttackExecuted)).toBeUndefined();
});

test('chat search preserves diagram labels, result order and visible source highlighting', async ({ page }) => {
  await respond(page, fenced('flowchart LR\n A[Needle] --> B[Other]') + '\n\nNeedle in the paragraph.');
  await expect(diagrams(page)).toBeVisible();
  const label = diagrams(page).locator('svg text').filter({ hasText: 'Needle' });
  await expect.poll(() => label.evaluate(node => node.getNumberOfChars())).toBe(6);
  await page.locator('[data-chat-search-surface]').click({ position: { x: 20, y: 100 } });
  await page.keyboard.press('ControlOrMeta+f');
  await page.getByRole('searchbox').fill('Needle');
  await expect(page.getByText('1 / 2', { exact: true })).toBeVisible();
  await expect(page.locator('svg mark')).toHaveCount(0);
  await expect(page.locator('mark[aria-current="true"]')).toHaveCount(0);
  await expect.poll(() => label.evaluate(node => node.getNumberOfChars())).toBe(6);
  await page.getByRole('searchbox').press('Enter');
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
  await expect(page.locator('p > mark[aria-current="true"]')).toHaveText('Needle');
  await page.getByRole('searchbox').press('Shift+Enter');
  await expect(page.getByText('1 / 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show source', exact: true }).click();
  await expect(page.locator('pre mark[aria-current="true"]')).toHaveText('Needle');
  await expect(page.locator('svg mark')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show diagram', exact: true }).click();
  await expect.poll(() => label.evaluate(node => node.getNumberOfChars())).toBe(6);
  await page.getByRole('searchbox').press('Escape');
  await expect(page.locator('mark')).toHaveCount(0);
});

test('external image nodes fall back before fetching and leave other diagrams renderable', async ({ page }) => {
  const requests = [];
  await page.route('https://example.com/mermaid-image.png', route => {
    requests.push(route.request().url());
    return route.abort();
  });
  const url = 'https://example.com/mermaid-image.png';
  const imageNodes = [
    `A@{ img: "${url}", label: "Remote", h: 60 }`,
    `A@{ 'img': "${url}", label: "Remote" }`,
    `A@{ "\\u0069mg": "${url}", label: "Remote" }`,
    `A@{\n img: "${url}"\n label: "Remote"\n h: 60\n}`,
    `accTitle: An "accessible title\n A@{ img: "${url}", label: "Remote" }`,
    `accDescr: An "accessible description\n A@{ img: "${url}", label: "Remote" }`,
    `accDescr { An "accessible description }\n A@{ img: "${url}", label: "Remote" }`,
  ];
  const titledImage = `---\ntitle: A "quoted title\n---\nflowchart LR\n A@{ img: "${url}", label: "Remote" }`;
  const ordinary = 'flowchart LR\n accTitle: An "accessible title\n accDescr { An "accessible description }\n %% A@{ img: "https://example.com/mermaid-image.png" } is only a comment\n A@{ shape: rect, label: "img: ordinary text }" } --> B["Example @{ img: /example.png }"]';
  const embedded = 'flowchart LR\n A@{ img: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", label: "Embedded", h: 32 }';
  const titledOrdinary = '---\ntitle: A "quoted title\n---\n' + flow;
  await respond(page, [...imageNodes.map(node => fenced('flowchart LR\n ' + node)), fenced(titledImage), fenced(ordinary), fenced(embedded), fenced(titledOrdinary), fenced(flow)].join('\n\n'));
  await expect(page.getByText('Unable to render this diagram. The source is shown below.', { exact: true })).toHaveCount(8);
  await expect(diagrams(page)).toHaveCount(4);
  await expect(diagrams(page).first()).toContainText('img: ordinary text }');
  await expect(diagrams(page).nth(2)).toContainText('quoted title');
  await expect(diagrams(page).last()).toContainText('用户提问');
  await expect(page.locator('pre code.language-mermaid')).toHaveCount(8);
  expect(requests).toEqual([]);
});

test('chat search ignores diagram controls and error messages', async ({ page }) => {
  await respond(page, fenced('flowchart LR\n A[source] --> B[Other]') + '\n\n' + fenced('flowchart LR\n A[source'));
  await expect(diagrams(page)).toHaveCount(1);
  await expect(page.getByText('Unable to render this diagram. The source is shown below.', { exact: true })).toBeVisible();
  await page.locator('[data-chat-search-surface]').click({ position: { x: 20, y: 100 } });
  await page.keyboard.press('ControlOrMeta+f');
  await page.getByRole('searchbox').fill('source');
  await expect(page.getByText('1 / 2', { exact: true })).toBeVisible();
  await expect(page.locator('button mark, [role="status"] mark')).toHaveCount(0);
  await expect(page.locator('mark[aria-current="true"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show source', exact: true }).first().click();
  await expect(page.locator('pre mark[aria-current="true"]')).toHaveText('source');
  await page.getByRole('button', { name: 'Show diagram', exact: true }).click();
  await expect(page.locator('mark[aria-current="true"]')).toHaveCount(0);
  await page.getByRole('searchbox').press('Enter');
  await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
  await expect(page.locator('pre mark[aria-current="true"]')).toHaveText('source');
  await expect(page.locator('button mark, [role="status"] mark')).toHaveCount(0);
});
