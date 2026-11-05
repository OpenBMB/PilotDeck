import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestI18n } from '../../i18n/testInstance';
import { normalizedToChatMessages } from '../chat/hooks/useChatMessages';
import type { ChatMessage } from '../chat/types/types';
import { buildRenderableMessageItems, formatCompletedProcessTitle, groupProcessIntervals } from './processGrouping';
import { TurnProcessHeader } from './TurnProcessDisclosure';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const start = '2026-09-01T00:00:00Z', end = '2026-09-01T00:01:20Z';
const user: ChatMessage = { id: 'u', type: 'user', content: 'Inspect', timestamp: start };
const project = (messages: ChatMessage[], running = false) => groupProcessIntervals(messages,
  buildRenderableMessageItems(messages, { isAssistantWorking: running }), running);

it('counts every fetch separately from searches and retains mixed generic tool counts in both languages', async () => {
  const i18n = await createTestI18n('en');
  const tools: ChatMessage[] = ['web_fetch', 'WebFetch', 'web-fetch', 'web_search', 'run_command', 'example_tool'].map((toolName, i) => ({
    id: `call-${i}`, toolId: `call-${i}`, toolName, type: 'assistant', timestamp: start, content: '', isToolUse: true, toolResult: { content: 'done' },
  }));
  const duplicate = { ...tools[0], id: 'replayed-call' };
  expect(formatCompletedProcessTitle([...tools, duplicate], i18n.getFixedT('en', 'chat')))
    .toBe('Searched 1 time Fetched 3 pages Ran 1 command Used 1 tool');
  expect(formatCompletedProcessTitle(tools, i18n.getFixedT('zh-CN', 'chat')))
    .toBe('已搜索 1 次 已读取 3 个网页 已运行 1 条命令 已调用 1 个工具');
});

it.each(['completed', 'aborted_streaming', 'aborted_tools', 'model_error'])('uses execution bounds across %s and history refresh', async finishReason => {
  const normalized = { sessionId: 's', provider: 'pilotdeck' as const, timestamp: start, runId: 'r' };
  const timing = { startedAt: start, completedAt: end, finishReason };
  const rows = [
    { ...normalized, id: 'u', kind: 'text' as const, role: 'user' as const, content: 'Inspect' },
    { ...normalized, id: 'answer', kind: 'text' as const, role: 'assistant' as const, content: 'First token at 32 seconds', timestamp: '2026-09-01T00:00:32Z' },
    { ...normalized, id: 'complete', kind: 'complete' as const, turnTiming: timing, finishReason },
  ];
  const live = project(normalizedToChatMessages(rows))[0].afterTurnProcess!;
  const restored = project(normalizedToChatMessages([{ ...rows[0], turnTiming: timing }, rows[1]]))[0].afterTurnProcess!;
  expect(live.durationMs).toBe(80000);
  expect(restored.durationMs).toBe(80000);
  expect(live.hasRecordedDuration).toBe(true);
  expect(restored.defaultExpanded).toBe(finishReason !== 'completed');
  expect(restored.outcome).toBe(finishReason === 'completed' ? 'completed' : finishReason.startsWith('aborted') ? 'cancelled' : 'failed');
});

it('freezes observed terminal timing instead of snapping to an earlier text timestamp or continuing while idle', async () => {
  const i18n = await createTestI18n('en');
  vi.useFakeTimers(); vi.setSystemTime(new Date(start));
  const group = { id: 'turn', isRunning: true, startedAt: start, defaultExpanded: true, memberIds: [], durationMs: 32000 };
  const element = (running: boolean) => <I18nextProvider i18n={i18n}><TurnProcessHeader group={{ ...group, isRunning: running }}
    scope="test" expanded onExpandedChange={() => {}} /></I18nextProvider>;
  const view = render(element(true));
  act(() => { vi.advanceTimersByTime(80000); });
  view.rerender(element(false));
  expect(screen.getByText('Processed 1m 20s')).toBeTruthy();
  act(() => { vi.advanceTimersByTime(120000); });
  expect(screen.getByText('Processed 1m 20s')).toBeTruthy();
});

it('excludes idle gaps between resumed executions and does not double-count overlapping bounds', () => {
  const messages: ChatMessage[] = [{ ...user, turnTiming: { startedAt: start, completedAt: '2026-09-01T00:00:20Z', finishReason: 'aborted_streaming' } },
    { id: 'partial', type: 'assistant', timestamp: start, content: 'Partial', turnTiming: { startedAt: start, completedAt: '2026-09-01T00:00:20Z' } },
    { id: 'final', type: 'assistant', timestamp: end, content: 'Resumed result', turnTiming: { startedAt: '2026-09-01T00:01:00Z', completedAt: end, finishReason: 'completed' } }];
  const group = project(messages)[0].afterTurnProcess!;
  expect(group.durationMs).toBe(40000);
  expect(group.outcome).toBe('completed');
});

it.each([undefined, 'tool_execution_failed', 'permission_denied'])('folds a single completed fetch, including failed or denied attempts (%s)', async errorCode => {
  const i18n = await createTestI18n('en');
  const fetch: ChatMessage = { id: 'fetch', toolId: 'fetch', toolName: 'web_fetch', type: 'assistant', timestamp: start,
    content: '', isToolUse: true, toolResult: { isError: true, errorCode, content: 'Remote permission denied; this site requires a browser.' } };
  const items = project([user, fetch, { ...user, id: 'final', type: 'assistant', content: 'Used another source.' }]);
  const trace = items.find(item => item.turnTrace)!;
  expect(trace.turnTrace?.items.map(item => item.message.id)).toEqual(['fetch']);
  expect(trace.turnTrace?.defaultExpanded).toBe(false);
  expect(trace.processRun?.defaultExpanded).toBe(false);
  expect(items.some(item => item.message.id === 'fetch')).toBe(false);
  expect(formatCompletedProcessTitle([fetch], i18n.getFixedT('en', 'chat'))).toBe('Fetched 1 page');
});

it('keeps genuine pending permission controls expanded while work is active or stopped without a reply', () => {
  const fetch: ChatMessage = { id: 'fetch', toolId: 'fetch', toolName: 'web_fetch', type: 'assistant', timestamp: start,
    content: '', isToolUse: true, toolResult: { isError: true, errorCode: 'permission_required', content: 'Network fetch requires permission.' } };
  for (const running of [true, false]) {
    const trace = project([user, fetch], running).find(item => item.turnTrace)!;
    expect(trace.turnTrace?.defaultExpanded).toBe(true);
    expect(trace.processRun?.defaultExpanded).toBe(true);
  }
});
