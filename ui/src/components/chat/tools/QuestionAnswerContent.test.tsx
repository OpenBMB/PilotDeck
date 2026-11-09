// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../../i18n/testInstance';
import { normalizedToChatMessages } from '../hooks/useChatMessages';
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

it.each(['en', 'zh-CN'])('replays all answers and exact multi-select labels from normalized history (%s)', async language => {
  const i18n = await createTestI18n(language);
  const questions = [
    { question: 'Which paths?', header: 'Scope', multiSelect: true, options: [{ label: 'A, B' }, { label: 'C' }] },
    { question: 'How detailed?', header: 'Detail', options: [{ label: 'Summary' }, { label: 'Full' }] },
    { question: 'Which source?', header: 'Source', options: [{ label: 'Docs' }, { label: 'Code' }] },
  ];
  const answers = { 'Which paths?': ['A, B', 'C', 'Custom, answer'], 'How detailed?': 'Summary', 'Which source?': 'Docs' };
  const base = { sessionId: 'question-session', provider: 'pilotdeck' as const, timestamp: '2026-01-01T00:00:00Z' };
  const [message] = normalizedToChatMessages([
    { ...base, id: 'question-call', kind: 'tool_use', toolName: 'ask_user_question', toolId: 'question-call', toolInput: { questions, answers: {} } },
    { ...base, id: 'question-result', kind: 'tool_result', toolId: 'question-call', content: 'User has answered', isError: false, toolUseResult: { questions, answers } },
  ]);
  const { container } = render(<I18nextProvider i18n={i18n}><ToolRenderer toolName={message.toolName!}
    toolInput={message.toolInput} toolResult={message.toolResult} mode="input" /></I18nextProvider>);
  expect(screen.getByText(i18n.t('uiText.answersProgress', { answered: 3, count: 3 }))).toBeTruthy();
  expect(screen.queryByText(i18n.t('uiText.skipped'))).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: new RegExp(i18n.t('uiText.questionTool')) }));
  fireEvent.click(screen.getByRole('button', { name: /Scope\s*A, B, C, Custom, answer/ }));
  expect(container.querySelectorAll('[data-answer-selected="true"]')).toHaveLength(4);
  expect(screen.getByText('A, B').closest('[data-answer-selected]')?.getAttribute('data-answer-selected')).toBe('true');
  expect(screen.getByText('C').closest('[data-answer-selected]')?.getAttribute('data-answer-selected')).toBe('true');
});
