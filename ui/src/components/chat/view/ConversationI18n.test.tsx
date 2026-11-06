// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../../i18n/testInstance';
import { ToolRenderer } from '../tools/ToolRenderer';
import { UnifiedToolCall } from '../tools/UnifiedToolCall';
import { QuestionAnswerContent } from '../tools/components/ContentRenderers/QuestionAnswerContent';
import MessageRow from './MessageRow';
import { ProcessLiveStatus, ProcessTrace } from './ProcessTrace';
import { TurnProcessHeader } from './TurnProcessDisclosure';

afterEach(cleanup);

it('switches conversation controls, durations, fallback labels and image descriptions without remounting', async () => {
  const i18n = await createTestI18n('en');
  const image = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const view = render(<I18nextProvider i18n={i18n}>
    <TurnProcessHeader group={{ id: 'turn', isRunning: false, defaultExpanded: false, durationMs: 82000, memberIds: [] }}
      scope="test" expanded={false} onExpandedChange={() => {}} />
    <ToolRenderer toolName="TodoWrite" mode="input" toolInput={{ markdown: '- [x] Inspect changes\n- [ ] Verify changes' }} toolResult={{ content: 'Saved' }} />
    <ToolRenderer toolName="TodoWrite" mode="result" contentOnly toolInput={{}} toolResult={{ content: 'Saved' }} />
    <ToolRenderer toolName="example_tool" mode="result" toolInput={{}} toolResult={{ content: 'Result' }} />
    <QuestionAnswerContent questions={[{ question: 'Which path?', options: [{ label: 'Continue' }] }]} answers={{ 'Which path?': 'Continue' }} resolved />
    <UnifiedToolCall message={{ id: 'shell', type: 'assistant', timestamp: '2026-01-01', isToolUse: true, toolName: 'bash',
      toolInput: { command: 'echo hello', description: 'Build app' }, durationMs: 1200, toolResult: { content: 'Built' } }} createDiff={() => []} />
    <ProcessLiveStatus step={{ id: 'working', state: 'running' }} />
    <ProcessTrace label="Earlier steps" steps={[{ id: 'unnamed-step' }]} defaultExpanded />
    <MessageRow message={{ id: 'images', type: 'user', timestamp: '2026-01-01', content: '', images: [
      { data: image, name: '' }, { data: image, name: 'fixture.png' },
    ] }} prevMessage={null} selectedProject={null} provider="pilotdeck" createDiff={() => []} />
  </I18nextProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Ran Build app' }));
  const shell = view.container.querySelector('[data-tool-id]');
  for (const language of ['en', 'zh-CN', 'en']) {
    await act(async () => { await i18n.changeLanguage(language); });
    const zh = language === 'zh-CN';
    expect(screen.getByText(zh ? '已处理 1 分 22 秒' : 'Processed 1m 22s')).toBeTruthy();
    expect(screen.getByRole('button', { name: zh ? '待办事项 已完成 1/2' : 'Todo list 1/2 completed' })).toBeTruthy();
    expect(screen.getByText(zh ? '待办事项已更新' : 'Todo list updated')).toBeTruthy();
    expect(screen.getByText(zh ? '详情' : 'Details')).toBeTruthy();
    expect(screen.getByText(zh ? '已回答 1/1' : 'Answered 1/1')).toBeTruthy();
    expect(screen.getByText(zh ? '提问' : 'Questions')).toBeTruthy();
    expect(screen.getByText(zh ? '执行过程' : 'Working')).toBeTruthy();
    expect(screen.getByText(zh ? '步骤' : 'Step')).toBeTruthy();
    expect(screen.getByText(zh ? '终端' : 'Shell')).toBeTruthy();
    expect(screen.getByText(zh ? '· 1.2 秒' : '· 1.2s')).toBeTruthy();
    expect(screen.getByRole('button', { name: zh ? '预览图片' : 'Preview image' })).toBeTruthy();
    expect(screen.getByRole('button', { name: zh ? '预览 fixture.png' : 'Preview fixture.png' })).toBeTruthy();
    expect(screen.getByRole('img', { name: zh ? '已上传图片' : 'Uploaded image' })).toBeTruthy();
    expect(view.container.querySelector('[data-tool-id]')).toBe(shell);
  }
});
