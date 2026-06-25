import { describe, it, expect } from 'vitest';
import { collectToolCalls } from '../../../src/agent/loop/collectToolCalls.js';
import type { CanonicalMessage } from '../../../src/model/index.js';

describe('collectToolCalls', () => {
  it('extracts tool call blocks from an assistant message', () => {
    const message: CanonicalMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me search for that.' },
        {
          type: 'tool_call',
          id: 'call_0001',
          name: 'web_search',
          input: { query: 'weather in Tokyo' },
        },
        {
          type: 'tool_call',
          id: 'call_0002',
          name: 'read_file',
          input: { path: '/tmp/test.txt' },
        },
      ],
    };

    const calls = collectToolCalls(message);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.id).toBe('call_0001');
    expect(calls[0]!.name).toBe('web_search');
    expect(calls[1]!.id).toBe('call_0002');
    expect(calls[1]!.name).toBe('read_file');
  });

  it('returns empty array for messages with no tool calls', () => {
    const message: CanonicalMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hello!' },
      ],
    };

    const calls = collectToolCalls(message);
    expect(calls).toHaveLength(0);
  });

  it('returns empty array for empty content', () => {
    const message: CanonicalMessage = {
      role: 'assistant',
      content: [],
    };

    const calls = collectToolCalls(message);
    expect(calls).toHaveLength(0);
  });

  it('handles tool calls with complex input objects', () => {
    const message: CanonicalMessage = {
      role: 'assistant',
      content: [
        {
          type: 'tool_call',
          id: 'call_0003',
          name: 'edit_file',
          input: {
            path: '/tmp/file.txt',
            operations: [
              { type: 'insert', position: 5, text: 'new content' },
            ],
          },
        },
      ],
    };

    const calls = collectToolCalls(message);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('edit_file');
    expect(calls[0]!.input).toEqual({
      path: '/tmp/file.txt',
      operations: [{ type: 'insert', position: 5, text: 'new content' }],
    });
  });
});
