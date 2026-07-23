import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { normalizedToChatMessages } from './useChatMessages';

const base = {
  sessionId: 'session-1',
  provider: 'pilotdeck' as const,
};

describe('file artifact message grouping', () => {
  it('attaches artifacts to the preceding final assistant reply', () => {
    const messages: NormalizedMessage[] = [
      {
        ...base,
        id: 'assistant-1',
        timestamp: '2026-07-21T10:00:00.000Z',
        kind: 'text',
        role: 'assistant',
        content: 'Finished.',
      },
      {
        ...base,
        id: 'artifacts-1',
        timestamp: '2026-07-21T10:00:01.000Z',
        kind: 'file_artifacts',
        artifacts: [{
          id: 'artifact-1',
          name: 'report.xlsx',
          path: 'report.xlsx',
          operation: 'created',
          source: 'workspace_diff',
          status: 'complete',
          size: 42,
          sha256: 'a'.repeat(64),
          createdAt: '2026-07-21T10:00:01.000Z',
        }],
      },
    ];

    const result = normalizedToChatMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Finished.');
    expect(result[0].artifacts?.[0]?.path).toBe('report.xlsx');
  });

  it('keeps artifacts visible when a failed turn has no final assistant reply', () => {
    const messages: NormalizedMessage[] = [{
      ...base,
      id: 'artifacts-1',
      timestamp: '2026-07-21T10:00:01.000Z',
      kind: 'file_artifacts',
      artifacts: [{
        id: 'artifact-1',
        name: 'partial.docx',
        path: 'partial.docx',
        operation: 'created',
        source: 'workspace_diff',
        status: 'incomplete',
        size: 12,
        sha256: 'b'.repeat(64),
        createdAt: '2026-07-21T10:00:01.000Z',
      }],
    }];

    const result = normalizedToChatMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].artifacts?.[0]?.status).toBe('incomplete');
  });
});
