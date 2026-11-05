import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { normalizedToChatMessages } from './useChatMessages';

const content = String.raw`\ref{sec:test} \textbf{Title} \newcommand{\x}{1}
C:\research\notes\table.tex
"\r\n\t" &lt;tag&gt; &amp; __MATH_BLOCK_0__
$\text{test}$` + '\n\tactual tab\r\nactual CRLF';

describe('chat message content fidelity', () => {
  it('preserves authoritative reasoning timing independently of history timestamps', () => {
    const msg: NormalizedMessage = {
      id: 'thought', sessionId: 's', runId: 'turn', timestamp: '2026-01-01T01:00:00Z', provider: 'pilotdeck',
      kind: 'thinking', content: 'Plan', streamState: 'closed',
      timeline: { version: 1, turnId: 'turn', id: 'thought', order: 0, revision: 2,
        startedAt: '2026-01-01T00:00:00Z', durationMs: 4200 },
    };
    expect(normalizedToChatMessages([JSON.parse(JSON.stringify(msg))])[0]).toMatchObject({
      isStreaming: false, startedAt: msg.timeline!.startedAt, durationMs: 4200,
    });
    expect(normalizedToChatMessages([{ ...msg, timeline: undefined }])[0].durationMs).toBeUndefined();
  });

  it.each([
    ['user', 'text', 'user-1'], ['assistant', 'text', 'assistant-1'],
    ['assistant', 'stream_delta', '__streaming_assistant_1'],
    ['assistant', 'thinking', 'thinking-1'], ['assistant', 'thinking', '__streaming_thinking_1'],
  ] as const)('preserves %s %s content (%s)', (role, kind, id) => {
    const msg: NormalizedMessage = {
      id, sessionId: 's', timestamp: '2026-09-09T00:00:00Z', provider: 'pilotdeck', role, kind, content,
    };
    expect(normalizedToChatMessages([msg])[0].content).toBe(content);
    // History reload creates fresh objects; it must not decode content again.
    expect(normalizedToChatMessages([JSON.parse(JSON.stringify(msg))])[0].content).toBe(content);
  });

  it('preserves all prefixes when a backslash command arrives across streaming frames', () => {
    for (let i = 1; i <= content.length; i++) {
      const partial = content.slice(0, i);
      expect(normalizedToChatMessages([{
        id: '__streaming_assistant_1', sessionId: 's', timestamp: '2026-09-09T00:00:00Z',
        provider: 'pilotdeck', kind: 'stream_delta', role: 'assistant', content: partial,
      }])[0].content).toBe(partial);
    }
  });
});
