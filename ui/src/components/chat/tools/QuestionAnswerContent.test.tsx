// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../../i18n/testInstance';
import { ToolRenderer } from './ToolRenderer';
afterEach(cleanup);
it('distinguishes unanswered, skipped and answered questions using the tool result', async () => {
  const i18n = await createTestI18n('zh-CN');
  const input = { questions:[{question:'请选择测试选项', options:[{label:'选项A'},{label:'选项B'}]}] };
  const view = (result?: unknown) => <I18nextProvider i18n={i18n}><ToolRenderer toolName="AskUserQuestion" toolInput={input} toolResult={result} mode="input" /></I18nextProvider>;
  const {rerender} = render(view());
  expect(screen.getByText('等待你回答')).toBeTruthy();
  expect(screen.queryByText('已跳过')).toBeNull();
  rerender(view({toolUseResult:{answers:{}}}));
  expect(screen.getByText('已跳过')).toBeTruthy();
  expect(screen.queryByText('等待你回答')).toBeNull();
  rerender(view({toolUseResult:{answers:{'请选择测试选项':'选项A'}}}));
  expect(screen.queryByText('已跳过')).toBeNull();
  expect(screen.queryByText('等待你回答')).toBeNull();
});
