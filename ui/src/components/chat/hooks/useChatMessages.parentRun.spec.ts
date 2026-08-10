import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { normalizedToChatMessages } from './useChatMessages';

describe('normalizedToChatMessages parent run identity', () => {
  it('preserves the parent run id on subagent activities', () => {
    const messages: NormalizedMessage[] = [{
      id: 'activity-1',
      sessionId: 'cron:task-1',
      provider: 'pilotdeck',
      timestamp: '2026-08-07T00:00:00.000Z',
      kind: 'agent_activity',
      activityId: 'subagent:child-1',
      runId: 'subagent:child-1',
      parentRunId: 'run-current',
      phase: 'subagent',
      state: 'running',
    }];

    expect(normalizedToChatMessages(messages)[0]).toMatchObject({
      isAgentActivity: true,
      runId: 'subagent:child-1',
      parentRunId: 'run-current',
    });
  });
});
