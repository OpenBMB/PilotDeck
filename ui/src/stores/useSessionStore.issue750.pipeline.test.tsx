// Issue #750 reproduction: chat history displayed incorrectly after refresh.
// The fixture pages were produced by the REAL readWebSessionMessages against
// transcripts shaped like the reporter's session: a completed turn, accepted
// inputs that never produced a model call, then the final completed turn.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../utils/api';
import { useSessionStore, type NormalizedMessage } from './useSessionStore';
import { normalizedToChatMessages } from '../components/chat/hooks/useChatMessages';
import {
  buildRenderableMessageItems,
  groupProcessIntervals,
} from '../components/chat/utils/processGrouping';

vi.mock('../utils/api', () => ({ authenticatedFetch: vi.fn(), readAgentStatusErrorFromResponse: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const base = { sessionId: 's', provider: 'pilotdeck' as const, timestamp: '2026-11-09T12:00:00Z' };
const legacy = (id: string, role: 'user' | 'assistant', turnId: string, text: string): NormalizedMessage =>
  ({ ...base, id, kind: 'text', role, turnId, runId: turnId, text });
const timed = (index: number, role: 'user' | 'assistant', turnId: string, text: string, order: number): NormalizedMessage =>
  ({ ...base, id: `p-b-${index}`, kind: 'text', role, turnId, runId: turnId, text, blockId: `block-${index}`,
    timeline: { version: 1, turnId, id: `blk-${index}`, order, revision: order + 1 }, isFinal: true });

const legacyPage: NormalizedMessage[] = [
  legacy('l-0', 'user', 'r-a', '怎么感觉又不动了，yolo-UAV'),
  legacy('l-1', 'assistant', 'r-a', 'thinking step 0'),
  legacy('l-2', 'assistant', 'r-a', 'thinking step 1'),
  legacy('l-3', 'assistant', 'r-a', '这次不是卡死，是误会——系统其实挺健康的'),
  legacy('l-4', 'user', 'r-c', '现在是什么情况？'),
  legacy('l-5', 'user', 'r-d', '还在吗？'),
  legacy('l-6', 'user', 'r-e', '模型又不调用了？'),
  legacy('l-7', 'user', 'r-f', 'train 停了吗？'),
  legacy('l-8', 'user', 'r-b', '整个系统出啥问题了，都不调用模型了，一直空跑时间？'),
  legacy('l-9', 'assistant', 'r-b', 'work step 0'),
  legacy('l-10', 'assistant', 'r-b', '查清楚了，问题不在模型端，而在今天11:23重启后的新版agent server'),
];

const timelinePage: NormalizedMessage[] = [
  timed(0, 'user', 'r-a', '怎么感觉又不动了，yolo-UAV', -1),
  timed(1, 'assistant', 'r-a', 'thinking step 0', 0),
  timed(2, 'assistant', 'r-a', 'thinking step 1', 1),
  timed(3, 'assistant', 'r-a', '这次不是卡死，是误会——系统其实挺健康的', 2),
  timed(4, 'user', 'r-c', '现在是什么情况？', -1),
  timed(5, 'user', 'r-d', '还在吗？', -1),
  timed(6, 'user', 'r-e', '模型又不调用了？', -1),
  timed(7, 'user', 'r-f', 'train 停了吗？', -1),
  timed(8, 'user', 'r-b', '整个系统出啥问题了，都不调用模型了，一直空跑时间？', -1),
  timed(9, 'assistant', 'r-b', 'work step 0', 0),
  timed(10, 'assistant', 'r-b', '查清楚了，问题不在模型端，而在今天11:23重启后的新版agent server', 1),
];

const response = (messages: NormalizedMessage[], nextCursor?: string, extra = {}) => ({
  ok: true, json: async () => ({ messages, total: messages.length, hasMore: Boolean(nextCursor), ...extra }),
} as Response);

const toPage = (messages: NormalizedMessage[]) => messages.map((message) => {
  const { text, ...rest } = message as NormalizedMessage & { text: string };
  return { ...rest, content: text } as NormalizedMessage;
});

const USER_PROMPTS = [
  '怎么感觉又不动了，yolo-UAV',
  '现在是什么情况？',
  '还在吗？',
  '模型又不调用了？',
  'train 停了吗？',
  '整个系统出啥问题了，都不调用模型了，一直空跑时间？',
];

it.each([
  ['legacy', legacyPage],
  ['timeline', timelinePage],
])('pairs every reply with its own prompt after a fresh refresh (%s page)', async (_name, messages) => {
  const { result } = renderHook(() => useSessionStore());
  const store = result.current;
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response(toPage(messages)));
  await act(async () => { await store.fetchFromServer('s', { direction: 'backward', limit: 100 }); });

  const prompts = store.getMessages('s').filter(m => m.kind === 'text' && m.role === 'user').map(m => m.content || '');
  expect(prompts).toHaveLength(USER_PROMPTS.length);
  USER_PROMPTS.forEach((prompt) => {
    expect(prompts.some(text => text.startsWith(prompt.slice(0, 7)))).toBe(true);
  });
  const rows = store.getMessages('s').filter(m => m.kind === 'text');
  expect(rows.find(m => m.role === 'assistant' && m.content?.includes('这次不是卡死'))).toBeTruthy();
  expect(rows.at(-1)?.role).toBe('assistant');
  expect(rows.at(-1)?.content).toContain('查清楚了');
  expect(rows.at(-1)?.content).not.toContain('这次不是卡死');

  // The settled transcript folds per turn: the prompt of a completed turn is
  // directly followed by that turn's own reply as the fold output.
  const chat = normalizedToChatMessages(store.getMessages('s'));
  const items = groupProcessIntervals(chat, buildRenderableMessageItems(chat, { isAssistantWorking: false }), false);
  const userAItem = items.find(item => item.message.type === 'user' && item.message.content?.startsWith('怎么感觉又不动了'));
  const replyBItem = items.find(item => item.message.type === 'assistant' && item.message.content?.includes('查清楚了'));
  expect(userAItem).toBeTruthy();
  expect(replyBItem?.processOutput).toBe(true);
  // 查清楚了 belongs to the final turn's fold, never to 怎么感觉又不动了's fold.
  expect(userAItem!.afterTurnProcess?.id).not.toBe(replyBItem!.processRun?.id);
});

// A refresh racing an active run can pair a stale transcript snapshot with the
// active-run baseline: the page's tail predates the newest accepted inputs,
// while the stream baseline supplies that turn's work and reply frames — which
// never include user rows. The reported symptom folds the earlier prompt
// together with the newest reply until full history has been read.
const stalePage: NormalizedMessage[] = [
  legacy('s-0', 'user', 'r-a', '怎么感觉又不动了，yolo-UAV'),
  legacy('s-1', 'assistant', 'r-a', 'turn A early thinking'),
];
const activeStreamFrames: NormalizedMessage[] = [
  { ...base, id: 'f-1', kind: 'thinking', role: 'assistant', content: 'checking server', runId: 'r-b',
    timeline: { version: 1, turnId: 'r-b', id: 't-b-1', order: 0, revision: 2 }, isFinal: true },
  { ...base, id: 'f-2', kind: 'stream_delta', role: 'assistant', content: '查清楚了，问题不在模型端，而在今天11:23重启后的新版agent server',
    runId: 'r-b', isFinal: false,
    timeline: { version: 1, turnId: 'r-b', id: 't-b-2', order: 2, revision: 3, offset: 0 } },
];

it('never folds the newest reply under an earlier prompt when the page predates the turn anchor', async () => {
  const { result } = renderHook(() => useSessionStore());
  const store = result.current;
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response(toPage(stalePage)));
  await act(async () => { await store.fetchFromServer('s', { direction: 'backward', limit: 100 }); });
  act(() => {
    for (const frame of activeStreamFrames) store.applyTimelineMessage('s', frame);
  });

  const chat = normalizedToChatMessages(store.getMessages('s'));
  const items = groupProcessIntervals(chat, buildRenderableMessageItems(chat, { isAssistantWorking: false }), false);
  expect(chat.filter(m => m.type === 'user').map(m => m.content)).toEqual(['怎么感觉又不动了，yolo-UAV']);

  const userAItem = items.find(item => item.message.type === 'user');
  const replyBItem = items.find(item => item.message.type === 'assistant' && item.message.content?.includes('查清楚了'));
  expect(userAItem).toBeTruthy();
  expect(replyBItem).toBeTruthy();
  // The anchor-less tail turn owns its fold: the newest reply is not the
  // output of the only prompt the stale window contained.
  expect(userAItem!.afterTurnProcess?.id).not.toBe(replyBItem!.processRun?.id);
  expect(replyBItem!.processRun).toBeTruthy();
});
