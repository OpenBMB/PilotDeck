// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useVideoJobs } from './useVideoJobs';
import GeneratedVideoCard from './GeneratedVideoCard';
import type { ChatMessage } from '../types/types';
import { normalizedToChatMessages } from '../hooks/useChatMessages';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch: mocks.fetch, appendAuthToken: (url: string) => url }));
afterEach(() => { cleanup(); vi.useRealTimers(); mocks.fetch.mockReset(); });
const pending = { id: 'call', sessionId: 'web:session', timestamp: '', type: 'assistant', isToolUse: true, toolName: 'generate_video', toolId: 'call', toolInput: { purpose: 'deliverable' }, toolResult: { isError: true, content: 'cancelled wait' } } as ChatMessage;
it('retains session identity through normalization and fetches an interrupted result while the process is folded', async () => {
  const messages = normalizedToChatMessages([{ id: 'c', sessionId: 'web:session', timestamp: '', provider: 'pilotdeck', kind: 'tool_use', toolId: 'call', toolName: 'generate_video', toolInput: { purpose: 'deliverable' } }]);
  expect(messages[0].sessionId).toBe('web:session');
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'job', sessionId: 'web:session', toolCallId: 'call', purpose: 'deliverable', state: 'completed', video: { videoId: 'video', sessionId: 'web:session', purpose: 'deliverable' } }) });
  const { result } = renderHook(() => useVideoJobs([pending]));
  await waitFor(() => expect(result.current[0].toolResult?.isError).toBe(false));
  expect(result.current[0].toolResult?.toolUseResult).toMatchObject({ videoGeneration: { videoId: 'video' } });
  expect(result.current[0].toolId).toBe('call'); expect(mocks.fetch.mock.calls[0][0]).toContain('web%3Asession/call/call');
});
it('retries a local host disconnection, then stops polling completed results', async () => {
  vi.useFakeTimers();
  mocks.fetch.mockRejectedValueOnce(new TypeError('network')).mockResolvedValue({ ok: true, json: async () => ({ id: 'job', state: 'completed', sessionId: 'web:session', video: { videoId: 'video', sessionId: 'web:session', purpose: 'deliverable' } }) });
  const messages = [pending]; const { result } = renderHook(() => useVideoJobs(messages));
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  expect(result.current[0].toolResult?.isError).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});

it('updates a live child card through reconnect, pause, resume and completion without reloading history', async () => {
  vi.useFakeTimers();
  const [child] = normalizedToChatMessages([{ id: 'child-call', sessionId: 'web:parent', subagentId: 'child-id',
    turnId: 'parent-turn', timestamp: '', provider: 'pilotdeck', kind: 'tool_use', toolId: 'call', toolName: 'generate_video', toolInput: { purpose: 'deliverable' } }]);
  const view = { id: 'job', sessionId: 'workspace::sub::child-id', toolCallId: 'call', purpose: 'deliverable' };
  let state = 'reconnecting';
  mocks.fetch.mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') return { ok: true, json: async () => ({ ...view, state: 'tracking' }) };
    return { ok: true, json: async () => ({ ...view, state, ...(state === 'completed' ? { video: { videoId: 'video', sessionId: view.sessionId, purpose: 'deliverable' } } : {}) }) };
  });
  const messages = [child];
  function Card() { const result = useVideoJobs(messages); return <GeneratedVideoCard message={result[0]} running={false} />; }
  const { container } = render(<Card />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(mocks.fetch.mock.calls[0][0]).toBe('/api/video-generation/jobs/web%3Aparent%3A%3Asub%3A%3Achild-id/call/call');
  expect(screen.getByRole('status').textContent).toContain('videoGeneration.reconnecting');
  state = 'paused';
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  fireEvent.click(screen.getByRole('button', { name: 'videoGeneration.resume' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(mocks.fetch.mock.calls.some(([url, init]) => init?.method === 'POST' && url === '/api/video-generation/jobs/workspace%3A%3Asub%3A%3Achild-id/job/resume')).toBe(true);
  state = 'completed';
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  expect(container.querySelector('video')?.src).toContain('workspace%3A%3Asub%3A%3Achild-id/video');
});

it('isolates sibling tasks with the same parent transport session and call ID', async () => {
  const messages = ['a', 'b'].map(subagentId => ({ ...pending, sessionId: 'web:parent', subagentId, turnId: 'parent-turn' }));
  mocks.fetch.mockImplementation(async url => {
    const child = String(url).includes('sub%3A%3Aa/') ? 'a' : 'b';
    return { ok: true, json: async () => ({ id: child, sessionId: 'actual::sub::' + child, state: 'completed', purpose: 'deliverable', video: { videoId: child, sessionId: 'actual::sub::' + child, purpose: 'deliverable' } }) };
  });
  const { result } = renderHook(() => useVideoJobs(messages));
  await waitFor(() => expect(result.current.every(m => m.toolResult?.isError === false)).toBe(true));
  expect(result.current.map(m => (m.toolResult!.toolUseResult as any).videoGeneration.videoId)).toEqual(['a', 'b']);
  expect(new Set(mocks.fetch.mock.calls.map(([url]) => url)).size).toBe(2);
});

it.each(['web:parent::sub::child', 'workspace::sub::child'])('keeps an already scoped child session unchanged: %s', async sessionId => {
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'job', sessionId, state: 'paused', purpose: 'deliverable' }) });
  const { result } = renderHook(() => useVideoJobs([{ ...pending, sessionId, subagentId: 'child' }]));
  await waitFor(() => expect(result.current[0].videoJob).toBeTruthy());
  expect(mocks.fetch.mock.calls[0][0]).toBe('/api/video-generation/jobs/' + encodeURIComponent(sessionId) + '/call/call');
});
