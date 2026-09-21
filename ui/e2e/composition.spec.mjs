import { expect, test } from '@playwright/test';

async function navigate(page, label) {
  const menu = page.getByRole('button', { name: '打开导航' });
  if (await menu.isVisible()) await menu.click();
  await page.locator('.prototype-sidebar').getByRole('button', { name: label, exact: true }).click();
}

test('profile assembly, replacement, interactions and layout', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/composition.html');
  await expect(page.getByText('发布审批等待确认')).toBeVisible();
  await expect.poll(() => page.locator('.prototype-brand img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByText('发布审批已确认')).toBeVisible();
  await page.getByLabel('消息', { exact: true }).fill('补充回滚检查');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('补充回滚检查', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('chat.png'), fullPage: true });

  await navigate(page, '知识库');
  await page.getByRole('textbox', { name: '搜索知识库' }).fill('回滚');
  await expect(page.locator('.prototype-document')).toHaveCount(1);
  await page.locator('.prototype-document').click();
  await expect(page.getByText('确认数据兼容性、备份状态及回滚负责人。', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('knowledge.png'), fullPage: true });
  await navigate(page, '流程');
  await page.getByRole('button', { name: '通过', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('审批已通过');
  await navigate(page, '设置');
  await expect(page.getByRole('textbox', { name: '知识版本', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '默认流程', exact: true })).toBeVisible();

  await page.getByLabel('组合 Profile').selectOption('native');
  await expect(page.locator('nav button')).toHaveText(['对话', '技能']);
  await expect(page.getByText('知识引用 · 产品发布流程.md')).toHaveCount(0);
  await expect(page.getByText('发布审批等待确认')).toHaveCount(0);
  await navigate(page, '设置');
  await expect(page.getByRole('textbox', { name: '知识版本', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '默认流程', exact: true })).toHaveCount(0);

  await page.getByLabel('组合 Profile').selectOption('minimal');
  await expect(page.locator('nav button')).toHaveText(['对话']);
  await page.getByLabel('组合 Profile').selectOption('replacement');
  await expect(page.locator('nav button')).toHaveText(['对话', '技能', '流程', '知识检索']);
  await navigate(page, '知识检索');
  await expect(page.getByRole('heading', { name: '知识检索' })).toBeVisible();
  await expect(page.locator('.prototype-stats')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('replacement.png'), fullPage: true });

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  for (const [profile, message] of [['invalid', 'Required slot cannot be disabled: context'], ['incompatible', 'Unsupported backend contract: knowledge']]) {
    await page.getByLabel('组合 Profile').selectOption(profile);
    await expect(page.getByRole('alert')).toContainText(message);
    await expect(page.locator('.prototype-workspace')).toHaveCount(0);
  }
  await page.getByRole('button', { name: '返回可用组合' }).click();
  await expect(page.getByText('发布审批等待确认')).toBeVisible();
  expect(errors).toEqual([]);
});
