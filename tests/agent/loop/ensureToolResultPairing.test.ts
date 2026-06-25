import { describe, it, expect } from 'vitest';
import {
  ensureToolResultPairing,
  createMissingToolResult,
} from '../../../src/agent/loop/ensureToolResultPairing.js';
import type { CanonicalToolCall } from '../../../src/model/index.js';

describe('ensureToolResultPairing', () => {
  const makeToolCall = (overrides: Partial<CanonicalToolCall> = {}): CanonicalToolCall => ({
    id: 'call_1234',
    name: 'test_tool',
    input: { query: 'hello' },
    ...overrides,
  });

  it('pairs successful tool calls with results', () => {
    const calls = [makeToolCall({ id: 'call_0001' })];
    const results = [{
      type: 'success' as const,
      toolCallId: 'call_0001',
      toolName: 'test_tool',
      data: 'hello world',
    }];

    const paired = ensureToolResultPairing(calls, results, () => new Date());
    expect(paired).toHaveLength(1);
    expect(paired[0]!.type).toBe('success');
    expect(paired[0]!.toolCallId).toBe('call_0001');
  });

  it('pairs error results with tool calls', () => {
    const calls = [makeToolCall({ id: 'call_0002' })];
    const results = [{
      type: 'error' as const,
      toolCallId: 'call_0002',
      toolName: 'test_tool',
      error: { code: 'runtime_error', message: 'Something went wrong' },
      isError: true,
    }];

    const paired = ensureToolResultPairing(calls, results, () => new Date());
    expect(paired).toHaveLength(1);
    expect(paired[0]!.type).toBe('error');
    expect(paired[0]!.toolCallId).toBe('call_0002');
  });

  it('creates missing results for calls without corresponding results', () => {
    const calls = [
      makeToolCall({ id: 'call_0003' }),
      makeToolCall({ id: 'call_0004' }),
    ];
    const results = [{
      type: 'success' as const,
      toolCallId: 'call_0003',
      toolName: 'test_tool',
      data: 'result',
    }];

    const paired = ensureToolResultPairing(calls, results, () => new Date());
    expect(paired).toHaveLength(2);
    expect(paired[0]!.toolCallId).toBe('call_0003');
    expect(paired[1]!.toolCallId).toBe('call_0004');
    expect(paired[1]!.type).toBe('error');
  });
});

describe('createMissingToolResult', () => {
  it('creates an error result for a missing tool call', () => {
    const toolCall: CanonicalToolCall = {
      id: 'call_0001',
      name: 'test_tool',
      input: { query: 'test' },
    };
    const now = () => new Date('2025-01-01T00:00:00Z');
    const result = createMissingToolResult(toolCall, now, 'Execution failed');
    expect(result.type).toBe('error');
    expect(result.toolCallId).toBe('call_0001');
    expect(result.toolName).toBe('test_tool');
    expect(result.error.code).toBe('runtime_error');
    expect(result.error.message).toBe('Execution failed');
  });
});
