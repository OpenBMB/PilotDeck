// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../../i18n/testInstance';
import { copyTextToClipboard } from '../../../utils/clipboard';
import { UnifiedToolCall } from './UnifiedToolCall';
import { calculateDiff } from '../utils/messageTransforms';
import type { ChatMessage } from '../types/types';
vi.mock('../../../utils/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => true) }));
let i18n: Awaited<ReturnType<typeof createTestI18n>>;
beforeAll(async () => { i18n = await createTestI18n(); });
afterEach(cleanup);
const message: ChatMessage = { id: 'call', type: 'assistant', timestamp: '2026-09-15', isToolUse: true, toolName: 'bash', toolInput: { command: 'pnpm build', description: 'Build app' } };
const view = (value: ChatMessage, running = false) => <I18nextProvider i18n={i18n}><UnifiedToolCall message={value} createDiff={calculateDiff} running={running} /></I18nextProvider>;
describe('UnifiedToolCall', () => {
  it('keeps a manually opened call expanded while it runs and completes', () => {
    const { rerender } = render(view(message, true));
    fireEvent.click(screen.getByRole('button', { name: 'Running Build app' }));
    expect(screen.getByText('pnpm build')).toBeTruthy();
    rerender(view({ ...message, toolResult: { content: 'built' } }));
    expect(screen.getByRole('button', { name: 'Ran Build app' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('built')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ran Build app' }));
    rerender(view({ ...message, toolResult: { content: 'built again' } }));
    expect(screen.queryByText('built again')).toBeNull();
  });
  it('shows failures only inside details and does not claim the operation succeeded', () => {
    render(view({ ...message, toolResult: { isError: true, content: 'exit 1: test failed' } }));
    expect(screen.queryByText('Failed')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Command Build app' });
    fireEvent.click(toggle);
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('exit 1: test failed')).toBeTruthy();
  });
  it('treats historical calls without a result as unknown, not running', () => {
    const { container } = render(view(message));
    fireEvent.click(screen.getByRole('button', { name: 'Command Build app' }));
    expect(screen.getAllByText('No result recorded').length).toBeGreaterThan(0);
    expect(container.querySelector('.animate-spin')).toBeNull();
  });
  it('shows neutral write previews and preserves opening files', () => {
    const onFileOpen = vi.fn();
    render(<I18nextProvider i18n={i18n}><UnifiedToolCall message={{ ...message, toolName: 'write_file', toolInput: { file_path: 'src/app.ts', content: 'line one\nline two' }, toolResult: { content: 'ok' } }} createDiff={calculateDiff} onFileOpen={onFileOpen} /></I18nextProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Wrote app.ts' }));
    expect(screen.getByText('line two')).toBeTruthy();
    expect(screen.queryByText('New')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'src/app.ts' }));
    expect(onFileOpen).toHaveBeenCalledWith('src/app.ts', undefined);
  });
  it('keeps unknown MCP input and structured output inspectable', () => {
    render(view({ ...message, toolName: 'mcp__custom__lookup', toolInput: { query: 'test' }, toolResult: { content: { answer: 42 } } }));
    fireEvent.click(screen.getByRole('button', { name: 'Used test' }));
    const panel = screen.getByLabelText('Tool details');
    expect(within(panel).getByText(/"query": "test"/)).toBeTruthy();
    expect(within(panel).getByText(/"answer": 42/)).toBeTruthy();
  });
});

it('shows added and removed lines without marking context as added', () => {
  render(<I18nextProvider i18n={i18n}><UnifiedToolCall message={{ ...message, toolName: 'edit_file', toolInput: { file_path: 'a.ts', old_string: 'old', new_string: 'new' }, toolResult: { content: 'ok' } }} createDiff={() => [{ type: 'removed', content: 'old', lineNum: 1 }, { type: 'added', content: 'new', lineNum: 1 }, { type: 'context', content: 'unchanged', lineNum: 2 }]} /></I18nextProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Edited a.ts' }));
  expect(screen.getByText('old').parentElement?.className).toContain('bg-red');
  expect(screen.getByText('new').parentElement?.className).toContain('bg-green');
  expect(screen.getByText('unchanged').parentElement?.className).not.toMatch(/bg-red|bg-green/);
});

it('never adds a second raw-result disclosure for structured shell results', () => {
  render(view({ ...message, toolResult: { content: 'INTERNAL WRAPPER', toolUseResult: { stdout: 'hello', stderr: '', exitCode: 0 } } }));
  fireEvent.click(screen.getByRole('button', { name: 'Ran Build app' }));
  expect(screen.getByText('hello')).toBeTruthy();
  expect(screen.queryByText('INTERNAL WRAPPER')).toBeNull();
  expect(screen.queryByText('Raw parameters and result')).toBeNull();
});

it('names skill reads in Chinese and retains the requested skill name', async () => {
  const chinese = await createTestI18n('zh-CN');
  render(<I18nextProvider i18n={chinese}><UnifiedToolCall message={{ ...message, toolName: 'read_skill', toolInput: { skillName: 'weather' }, toolResult: { content: 'Weather instructions' } }} createDiff={calculateDiff} /></I18nextProvider>);
  fireEvent.click(screen.getByRole('button', { name: '已读取技能 weather' }));
  expect(screen.queryByText('read_skill')).toBeNull();
  expect(screen.getByText('Weather instructions')).toBeTruthy();
});


it.each(['pnpm build', 'printf "hello\\n"\npnpm build'])('copies the original shell command without prompt or output: %s', (command) => {
  vi.mocked(copyTextToClipboard).mockClear();
  render(view({ ...message, toolInput: { command, description: 'Build app' }, toolResult: { content: 'Build complete.' } }));
  fireEvent.click(screen.getByRole('button', { name: 'Ran Build app' }));
  fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
  expect(copyTextToClipboard).toHaveBeenCalledExactlyOnceWith(command);
});
