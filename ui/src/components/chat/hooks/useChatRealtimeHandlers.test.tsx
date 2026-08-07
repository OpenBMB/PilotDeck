import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';
import type { SessionStore } from '../../../stores/useSessionStore';
import { createAlwaysOnTurnEventForwarder } from '../../../../server/pilotdeck-bridge.js';
import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';

const mocks = vi.hoisted(() => ({
  listener: null as ((message: unknown) => void) | null,
  subscribe: vi.fn(),
}));

vi.mock('../../../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: mocks.subscribe }),
}));

const provider = 'pilotdeck' as SessionProvider;
const noop = () => undefined;

function createSessionStore() {
  return {
    cancelRunningActivities: vi.fn(),
    refreshFromServer: vi.fn().mockResolvedValue(undefined),
    setActiveSession: vi.fn(),
    finalizeStreaming: vi.fn(),
    finalizeStreamingThinking: vi.fn(),
    appendRealtime: vi.fn(),
  } as unknown as SessionStore;
}

describe('useChatRealtimeHandlers terminal errors', () => {
  beforeEach(() => {
    mocks.listener = null;
    mocks.subscribe.mockReset();
    mocks.subscribe.mockImplementation((listener) => {
      mocks.listener = listener;
      return noop;
    });
  });

  it('cancels running subagents when the bridge forwards agent_aborted', () => {
    const sessionStore = createSessionStore();
    renderHook(() => useChatRealtimeHandlers({
      provider,
      selectedProject: { name: 'project', fullPath: '/tmp/project' } as unknown as Project,
      selectedSession: { id: 'cron:task-1' } as unknown as ProjectSession,
      currentSessionId: 'cron:task-1',
      setCurrentSessionId: noop,
      setIsLoading: noop,
      setCanAbortSession: noop,
      setIsAborting: noop,
      setClaudeStatus: noop,
      setPilotDeckStatus: noop,
      setTokenBudget: noop,
      setPendingPermissionRequests: noop,
      pendingViewSessionRef: { current: null },
      sessionStore,
    }));

    act(() => {
      const forward = createAlwaysOnTurnEventForwarder((_sessionId, frame) => {
        mocks.listener?.(frame);
      });
      forward('always-on:turn-event', {
        sessionKey: 'cron:task-1',
        channelKey: 'cron',
        event: {
          type: 'error',
          code: 'agent_aborted',
          message: 'The run was stopped.',
          recoverable: true,
        },
      });
    });

    expect(sessionStore.cancelRunningActivities).toHaveBeenCalledWith('cron:task-1');
  });
});
