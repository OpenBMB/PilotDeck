// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage, SessionStore } from '../../stores/useSessionStore';
import { useSubagentMessages } from './useSubagentMessages';
import { authenticatedFetch } from '../../utils/api';

vi.mock('../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const message = (id: string, content: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id, sessionId: 'session', kind: 'thinking', content, provider: 'pilotdeck', timestamp: '2026-09-05T00:00:00Z', ...overrides,
});
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve: (messages: NormalizedMessage[]) => resolve({ ok: true, json: async () => ({ messages }) } as Response) };
}

describe('subagent refresh lifecycle', () => {
  it('retains the live tail while completion refresh is pending and bridges snapshot identity', async () => {
    const initial = deferred(); const final = deferred();
    vi.mocked(authenticatedFetch).mockReturnValueOnce(initial.promise).mockReturnValueOnce(final.promise);
    const realtime = [message('local-final', 'New thought', { renderKey: 'reader', timestamp: '2026-09-05T00:00:01Z' })];
    const store = { getSubagentDetailMessages: () => realtime } as unknown as SessionStore;
    const { result, rerender } = renderHook(({ status }) => useSubagentMessages('s', 'child', undefined, store, status), { initialProps: { status: 'running' } });
    await act(async () => initial.resolve([message('old', 'Old thought')]));
    expect(result.current.messages.map((row) => row.content)).toEqual(['Old thought', 'New thought']);
    rerender({ status: 'completed' });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.messages.map((row) => row.content)).toEqual(['Old thought', 'New thought']);
    await act(async () => final.resolve([message('old', 'Old thought'), message('snapshot-final', 'New thought')]));
    expect(result.current.messages[1].renderKey).toBe('reader');
    expect(result.current.isLoading).toBe(false);
  });

  it('isolates child scopes and ignores an aborted refresh that resolves late', async () => {
    const initial = deferred(); const stale = deferred(); const current = deferred();
    vi.mocked(authenticatedFetch).mockReturnValueOnce(initial.promise).mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const store = { getSubagentDetailMessages: (_session: string, child: string) => child === 'one'
      ? [message('live-one', 'Same thought', { renderKey: 'one-reader' })] : [] } as unknown as SessionStore;
    const { result, rerender } = renderHook(({ child, status }) => useSubagentMessages('s', child, undefined, store, status), {
      initialProps: { child: 'one', status: 'running' },
    });
    await act(async () => initial.resolve([]));
    rerender({ child: 'one', status: 'completed' });
    rerender({ child: 'two', status: 'completed' });
    expect(result.current.messages).toEqual([]);
    await act(async () => current.resolve([message('two-snapshot', 'Same thought')]));
    await act(async () => stale.resolve([message('one-snapshot', 'Same thought')]));
    expect(result.current.messages[0].id).toBe('two-snapshot');
    expect(result.current.messages[0].renderKey).not.toBe('one-reader');
  });

  it('keeps displayed content if a background refresh fails', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [message('old', 'Displayed thought')] }) } as Response)
      .mockRejectedValueOnce(new Error('Network reset'));
    const { result, rerender } = renderHook(({ status }) => useSubagentMessages('s', 'child', undefined, undefined, status), { initialProps: { status: 'running' } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ status: 'completed' });
    await waitFor(() => expect(result.current.error).toBe('Network reset'));
    expect(result.current.messages[0].content).toBe('Displayed thought');
  });
});
