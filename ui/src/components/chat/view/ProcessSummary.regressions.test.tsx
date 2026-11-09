import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestI18n } from '../../../i18n/testInstance';
import { normalizedToChatMessages } from '../hooks/useChatMessages';
import type { ChatMessage } from '../types/types';
import { buildRenderableMessageItems, formatCompletedProcessTitle, groupProcessIntervals } from '../utils/processGrouping';
import { TurnProcessHeader } from './TurnProcessDisclosure';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const start = '2026-09-01T00:00:00Z', end = '2026-09-01T00:01:20Z';
const user: ChatMessage = { id: 'u', type: 'user', content: 'Inspect', timestamp: start };
const project = (messages: ChatMessage[], running = false) => groupProcessIntervals(messages,
  buildRenderableMessageItems(messages, { isAssistantWorking: running }), running);

it('folds long sequential tool runs into stable bounded batches without dropping details', () => {
  const tools: ChatMessage[] = Array.from({ length: 101 }, (_, index) => ({
    id: `batch-${index}`, toolId: `batch-${index}`, toolName: 'run_command', type: 'assistant',
    timestamp: start, content: '', isToolUse: true, toolInput: { command: `check ${index}` },
    toolResult: index < 100 ? { content: 'ok' } : undefined,
  }));
  const previous = project([user, ...tools.slice(0, 10)], true).find(item => item.turnTrace)!.turnTrace!;
  const groups = project([user, ...tools], true).flatMap(item => item.turnTrace ? [item.turnTrace] : []);
  expect(groups.length).toBeGreaterThan(1);
  expect(groups.every(group => group.items.length <= 16)).toBe(true);
  expect(groups[0].id).toBe(previous.id);
  expect(groups.slice(0, -1).every(group => !group.defaultExpanded && !group.isLive)).toBe(true);
  expect(groups.at(-1)?.isLive).toBe(true);
  expect(groups.at(-1)?.defaultExpanded).toBe(true);
  expect(groups.flatMap(group => group.items.map(item => item.message.id))).toEqual(tools.map(tool => tool.id));
});

it('folds a full batch as soon as its last call settles without waiting for another event', () => {
  const tools: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
    id: `threshold-${index}`, toolId: `threshold-${index}`, toolName: 'bash', type: 'assistant',
    timestamp: start, content: '', isToolUse: true, toolInput: { command: `check ${index}` },
    toolResult: { content: 'ok' },
  }));
  const traces = (calls: ChatMessage[]) => project([user, ...calls], true).flatMap(item => item.turnTrace ? [item.turnTrace] : []);
  const short = traces(tools.slice(0, -1));
  expect(short).toHaveLength(1);
  expect(short[0].defaultExpanded).toBe(true);
  const pending = traces([...tools.slice(0, -1), { ...tools.at(-1)!, toolResult: undefined }]);
  expect(pending[0].defaultExpanded).toBe(true);
  expect(pending[0].isLive).toBe(true);
  const settled = traces(tools);
  expect(settled).toHaveLength(1);
  expect(settled[0].id).toBe(short[0].id);
  expect(settled[0].defaultExpanded).toBe(false);
  expect(settled[0].isLive).toBe(false);
  expect(settled[0].items.map(item => item.message.id)).toEqual(tools.map(tool => tool.id));
});

it('folds dense edits earlier than short calls and never repartitions on result growth', () => {
  const makeTools = (dense: boolean): ChatMessage[] => Array.from({ length: 30 }, (_, index) => ({
    id: `adaptive-${index}`, toolId: `adaptive-${index}`, toolName: dense ? 'write_file' : 'bash',
    toolInput: dense ? { file_path: `file-${index}.ts`, content: 'large input\n'.repeat(1000) } : { command: 'check' },
    type: 'assistant', timestamp: start, isToolUse: true, content: '', toolResult: { content: 'ok' },
  }));
  const traces = (tools: ChatMessage[]) => project([user, ...tools], true).flatMap(item => item.turnTrace ? [item.turnTrace] : []);
  const simple = traces(makeTools(false));
  const denseTools = makeTools(true);
  const dense = traces(denseTools);
  expect(dense[0].items.length).toBeLessThan(simple[0].items.length);
  expect(dense[0].items.length).toBeGreaterThan(1);
  const membership = (groups: typeof dense) => groups.map(group => [group.id, group.items.map(item => item.message.id)]);
  expect(membership(traces(denseTools.map(tool => ({ ...tool, toolResult: { content: 'result growth\n'.repeat(5000) } })))))
    .toEqual(membership(dense));
  expect(traces(makeTools(false).slice(0, 20))[0].id).toBe(simple[0].id);
  const boundaryTools = denseTools.map((tool, index) => ({ ...tool,
    toolInput: { file_path: `file-${index}.ts`, content: 'x'.repeat(3980) } }));
  expect(membership(traces(boundaryTools.map(tool => ({ ...tool, toolInput: JSON.stringify(tool.toolInput) })))))
    .toEqual(membership(traces(boundaryTools)));
});

it('batches all kinds of tool actions together and describes the mixed work in both languages', async () => {
  const i18n = await createTestI18n('en');
  const calls = [
    ['read_file', { file_path: 'source.ts' }], ['Read', { file_path: 'diagram.png' }],
    ['view_image', { path: 'reference.jpg' }], ['edit_file', { file_path: 'source.ts' }],
    ['write_file', { file_path: 'result.ts' }], ['web_search', { query: 'reference' }],
    ['web_fetch', { url: 'https://example.com' }], ['bash', { command: 'verify' }],
    ['generate_image', { purpose: 'intermediate' }], ['browser_navigate', { url: 'https://example.com' }],
    ['read_skill', { skillName: 'testing' }],
  ] as const;
  const tools: ChatMessage[] = calls.map(([toolName, toolInput], index) => ({
    id: `mixed-${index}`, toolId: `mixed-${index}`, toolName, toolInput, type: 'assistant', timestamp: start,
    isToolUse: true, content: '', toolResult: index < 10 ? { content: 'ok' } : undefined,
  }));
  const groups = project([user, ...tools], true).flatMap(item => item.turnTrace ? [item.turnTrace] : []);
  expect(groups.length).toBeGreaterThan(1);
  expect(groups.flatMap(group => group.items)).toHaveLength(11);
  expect(groups[0].defaultExpanded).toBe(false);
  const batch = tools.slice(0, 10);
  expect(formatCompletedProcessTitle(batch, i18n.getFixedT('en', 'chat'))).toBe(
    'Edited 2 files Explored 1 file Viewed 2 images Generated 1 image Opened 1 page Searched 1 time Fetched 1 page Ran 1 command');
  expect(formatCompletedProcessTitle(batch, i18n.getFixedT('zh-CN', 'chat'))).toBe(
    '已编辑 2 个文件 已探索 1 个文件 已查看 2 张图片 已生成 1 张图片 已打开 1 个网页 已搜索 1 次 已读取 1 个网页 已运行 1 条命令');
});

it('distinguishes image edits, browser interactions and skills from text files and page loads', async () => {
  const i18n = await createTestI18n('en');
  const tools: ChatMessage[] = ['edit_image', 'generate_video', 'browser_screenshot', 'mcp__playwright__browser_click', 'read_skill']
    .map((toolName, index) => ({ id: `semantic-${index}`, toolId: `semantic-${index}`, toolName,
      type: 'assistant', timestamp: start, isToolUse: true, content: '', toolResult: { content: 'ok' } }));
  expect(formatCompletedProcessTitle(tools, i18n.getFixedT('en', 'chat'))).toBe(
    'Edited 1 image Generated 1 video Performed 2 browser actions Loaded 1 skill');
  expect(formatCompletedProcessTitle({ ...user, type: 'system', viewedImageCount: 2, browserActionCount: 3 },
    i18n.getFixedT('zh-CN', 'chat'))).toBe('已查看 2 张图片 已执行 3 次浏览器操作');
});

it('retains anonymous legacy actions and deduplicates only calls with actual identities', async () => {
  const i18n = await createTestI18n('en');
  const image: ChatMessage = { type: 'assistant', timestamp: start, isToolUse: true, content: '', toolName: 'mcp__media__view_image' };
  expect(formatCompletedProcessTitle([image, { ...image }], i18n.getFixedT('en', 'chat'))).toBe('Viewed 2 images');
  expect(formatCompletedProcessTitle([{ ...image, toolId: 'same' }, { ...image, toolId: 'same' }],
    i18n.getFixedT('en', 'chat'))).toBe('Viewed 1 image');
});

it('keeps pending parallel calls active and accessible across batch boundaries', () => {
  const tools: ChatMessage[] = Array.from({ length: 21 }, (_, index) => ({
    id: `parallel-${index}`, toolId: `parallel-${index}`, toolName: 'run_command', type: 'assistant',
    timestamp: start, content: '', isToolUse: true,
  }));
  const groups = project([user, ...tools], true).flatMap(item => item.turnTrace ? [item.turnTrace] : []);
  expect(groups.length).toBeGreaterThan(1);
  expect(groups.every(group => group.items.length <= 16)).toBe(true);
  expect(groups.flatMap(group => group.items)).toHaveLength(21);
  expect(groups.every(group => group.isLive && group.defaultExpanded)).toBe(true);
  const stopped = project([user, ...tools]).flatMap(item => item.turnTrace ? [item.turnTrace] : []);
  expect(stopped.every(group => !group.isLive)).toBe(true);
});

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
