// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useVideoJobs } from './useVideoJobs';
import type { ChatMessage } from '../types/types';
import { normalizedToChatMessages } from '../hooks/useChatMessages';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
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
