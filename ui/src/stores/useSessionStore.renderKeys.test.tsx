import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizedToChatMessages } from '../components/chat/hooks/useChatMessages';
import { getIntrinsicMessageKey } from '../components/chat/utils/messageKeys';
import { inheritMessageRenderKeys, useSessionStore, type NormalizedMessage } from './useSessionStore';

afterEach(cleanup);
const msg = (id: string, runId = 'run'): NormalizedMessage => ({ id, sessionId: 'session', runId, kind: 'text', role: 'assistant', content: 'Same content', timestamp: '2026-09-05', provider: 'pilotdeck' });
describe('streaming presentation identity', () => {
  it.each(['thinking', 'text'])('keeps subagent %s identity and clears the live flag on completion', (kind) => {
    const { result } = renderHook(() => useSessionStore());
    const update = kind === 'thinking' ? result.current.updateSubagentDetailThinking : result.current.updateSubagentDetailStreaming;
    const finalize = kind === 'thinking' ? result.current.finalizeSubagentDetailThinking : result.current.finalizeSubagentDetailStreaming;
    act(() => update('session', 'child', 'Subagent block', 'pilotdeck'));
    const before = normalizedToChatMessages(result.current.getSubagentDetailMessages('session', 'child'))[0];
    expect(before.isStreaming).toBe(true);
    act(() => finalize('session', 'child'));
    const after = normalizedToChatMessages(result.current.getSubagentDetailMessages('session', 'child'))[0];
    expect(after.isStreaming).toBeFalsy();
    expect(getIntrinsicMessageKey(after)).toBe(getIntrinsicMessageKey(before));
  });
  it.each(['thinking', 'text'])('keeps the %s React key through finalization and allocates another for the next block', (kind) => {
    const { result } = renderHook(() => useSessionStore());
    const update = kind === 'thinking' ? result.current.updateStreamingThinking : result.current.updateStreaming;
    const finalize = kind === 'thinking' ? result.current.finalizeStreamingThinking : result.current.finalizeStreaming;
    act(() => update('session', 'First block', 'pilotdeck', 'run'));
    const before = normalizedToChatMessages(result.current.getMessages('session'))[0];
    act(() => finalize('session', 'run'));
    const after = normalizedToChatMessages(result.current.getMessages('session'))[0];
    expect(after.id).not.toBe(before.id);
    expect(getIntrinsicMessageKey(after)).toBe(getIntrinsicMessageKey(before));
    act(() => update('session', 'Second block', 'pilotdeck', 'run'));
    const second = normalizedToChatMessages(result.current.getMessages('session'))[1];
    expect(getIntrinsicMessageKey(second)).not.toBe(getIntrinsicMessageKey(before));
  });
  it('preserves keys when the server confirms content, without crossing runs or duplicating keys', () => {
    const previous = [{ ...msg('live'), renderKey: 'render-one' }];
    expect(inheritMessageRenderKeys(previous, [msg('server')])[0].renderKey).toBe('render-one');
    expect(inheritMessageRenderKeys(previous, [msg('server', 'other-run')])[0].renderKey).toBeUndefined();
    const duplicates = inheritMessageRenderKeys(previous, [msg('server'), { ...msg('live'), renderKey: 'render-one' }]);
    expect(duplicates[0].renderKey).toBeUndefined();
    expect(duplicates[1].renderKey).toBe('render-one');
  });
});
