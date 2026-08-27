import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';
import type { SessionStore } from '../../../stores/useSessionStore';
import {
  buildSessionStatusRequest,
  resetSessionStatusProtocolForTests,
} from '../sessionStatusProtocol';
import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';

const mocks = vi.hoisted(() => ({
  listener: null as ((message: unknown) => void) | null,
  sendMessage: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock('../../../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({ sendMessage: mocks.sendMessage, subscribe: mocks.subscribe }),
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
    setActivities: vi.fn(),
  } as unknown as SessionStore;
}

describe('useChatRealtimeHandlers terminal errors', () => {
  beforeEach(() => {
    resetSessionStatusProtocolForTests();
    mocks.listener = null;
    mocks.sendMessage.mockReset();
    mocks.subscribe.mockReset();
    mocks.subscribe.mockImplementation((listener) => {
      mocks.listener = listener;
      return noop;
    });
  });

  it('finalizes assistant streams when applied guidance creates a user boundary in the same run', () => {
    const sessionStore = createSessionStore();
    renderHook(() => useChatRealtimeHandlers({
      provider,
      selectedProject: { name: 'project', fullPath: '/tmp/project' } as unknown as Project,
      selectedSession: { id: 'web:s_test' } as unknown as ProjectSession,
      currentSessionId: 'web:s_test',
      setCurrentSessionId: noop,
      setIsLoading: noop,
      setSessionRuntimeState: noop,
      activeRunId: 'run-1',
      setActiveRunId: noop,
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
      mocks.listener?.({
        kind: 'text',
        role: 'user',
        content: 'Adjust direction',
        sessionId: 'web:s_test',
        runId: 'run-1',
        isSteer: true,
      });
    });

    expect(sessionStore.finalizeStreamingThinking).toHaveBeenCalledWith('web:s_test', 'run-1');
    expect(sessionStore.finalizeStreaming).toHaveBeenCalledWith('web:s_test', 'run-1');
    expect(sessionStore.appendRealtime).toHaveBeenCalledWith(
      'web:s_test',
      expect.objectContaining({ role: 'user', isSteer: true }),
    );
  });

  it('cancels running subagents for a terminal agent_aborted frame', () => {
    const sessionStore = createSessionStore();
    const setSessionRuntimeState = vi.fn();
    renderHook(() => useChatRealtimeHandlers({
      provider,
      selectedProject: { name: 'project', fullPath: '/tmp/project' } as unknown as Project,
      selectedSession: { id: 'cron:task-1' } as unknown as ProjectSession,
      currentSessionId: 'cron:task-1',
      setCurrentSessionId: noop,
      setIsLoading: noop,
      setSessionRuntimeState,
      activeRunId: null,
      setActiveRunId: noop,
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
      mocks.listener?.({
        kind: 'error',
        sessionId: 'cron:task-1',
        code: 'agent_aborted',
        content: 'The run was stopped.',
        terminal: true,
      });
    });

    expect(sessionStore.cancelRunningActivities).toHaveBeenCalledWith('cron:task-1');
    expect(setSessionRuntimeState).toHaveBeenCalledWith('inactive');
  });

  it('cancels running subagents for terminal errors other than agent_aborted', () => {
    const sessionStore = createSessionStore();
    const setSessionRuntimeState = vi.fn();
    renderHook(() => useChatRealtimeHandlers({
      provider,
      selectedProject: { name: 'project', fullPath: '/tmp/project' } as unknown as Project,
      selectedSession: { id: 'cron:task-1' } as unknown as ProjectSession,
      currentSessionId: 'cron:task-1',
      setCurrentSessionId: noop,
      setIsLoading: noop,
      setSessionRuntimeState,
      activeRunId: null,
      setActiveRunId: noop,
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
      mocks.listener?.({
        kind: 'error',
        sessionId: 'cron:task-1',
        code: 'gateway_disconnected',
        content: 'The gateway connection was lost.',
        terminal: true,
      });
    });

    expect(sessionStore.cancelRunningActivities).toHaveBeenCalledWith('cron:task-1');
    expect(setSessionRuntimeState).toHaveBeenCalledWith('inactive');
  });

  it('keeps subagents running and synchronizes status for a non-terminal session-busy error', () => {
    const sessionStore = createSessionStore();
    const setSessionRuntimeState = vi.fn();
    const setIsLoading = vi.fn();
    const setCanAbortSession = vi.fn();
    const onSessionInactive = vi.fn();
    renderHook(() => useChatRealtimeHandlers({
      provider,
      selectedProject: { name: 'project', fullPath: '/tmp/project' } as unknown as Project,
      selectedSession: { id: 'cron:task-1' } as unknown as ProjectSession,
      currentSessionId: 'cron:task-1',
      setCurrentSessionId: noop,
      setIsLoading,
      setSessionRuntimeState,
      activeRunId: null,
      setActiveRunId: noop,
      setCanAbortSession,
      setIsAborting: noop,
      setClaudeStatus: noop,
      setPilotDeckStatus: noop,
      setTokenBudget: noop,
      setPendingPermissionRequests: noop,
      pendingViewSessionRef: { current: null },
      onSessionInactive,
      sessionStore,
    }));

    act(() => {
      mocks.listener?.({
        kind: 'error',
        sessionId: 'cron:task-1',
        code: 'session_busy',
        content: 'This session already has an active turn.',
        terminal: false,
      });
    });

    expect(sessionStore.cancelRunningActivities).not.toHaveBeenCalled();
    expect(sessionStore.finalizeStreaming).not.toHaveBeenCalled();
    expect(sessionStore.finalizeStreamingThinking).not.toHaveBeenCalled();
    expect(onSessionInactive).not.toHaveBeenCalled();
    expect(setIsLoading).not.toHaveBeenCalled();
    expect(setCanAbortSession).not.toHaveBeenCalled();
    expect(setSessionRuntimeState).toHaveBeenCalledWith('synchronizing');
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: 'check-session-status',
      sessionId: 'cron:task-1',
      provider: 'pilotdeck',
      expectedActiveRunId: null,
      includeActiveTurnMessages: true,
      statusRequestId: 1,
    });
  });

  it('cancels running subagents when the parent turn completes', () => {
    const sessionStore = createSessionStore();
    const setSessionRuntimeState = vi.fn();
    const setActiveRunId = vi.fn();
    renderHook(() => useChatRealtimeHandlers({
      provider,
      selectedProject: { name: 'project', fullPath: '/tmp/project' } as unknown as Project,
      selectedSession: { id: 'cron:task-1' } as unknown as ProjectSession,
      currentSessionId: 'cron:task-1',
      setCurrentSessionId: noop,
      setIsLoading: noop,
      setSessionRuntimeState,
      activeRunId: 'run-current',
      setActiveRunId,
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
      mocks.listener?.({
        kind: 'complete',
        sessionId: 'cron:task-1',
        runId: 'run-current',
        exitCode: 1,
      });
    });

    expect(sessionStore.cancelRunningActivities).toHaveBeenCalledWith('cron:task-1');
    expect(setSessionRuntimeState).toHaveBeenCalledWith('inactive');
    expect(setActiveRunId).toHaveBeenCalledWith(null);
  });

  it('does not let terminal frames from an older run stop the active run', () => {
    const sessionStore = createSessionStore();
    const setSessionRuntimeState = vi.fn();
    const setActiveRunId = vi.fn();
    const onSessionInactive = vi.fn();
    renderHook(() => useChatRealtimeHandlers({
      provider,
      selectedProject: { name: 'project', fullPath: '/tmp/project' } as unknown as Project,
      selectedSession: { id: 'cron:task-1' } as unknown as ProjectSession,
      currentSessionId: 'cron:task-1',
      setCurrentSessionId: noop,
      setIsLoading: noop,
      setSessionRuntimeState,
      activeRunId: null,
      setActiveRunId,
      setCanAbortSession: noop,
      setIsAborting: noop,
      setClaudeStatus: noop,
      setPilotDeckStatus: noop,
      setTokenBudget: noop,
      setPendingPermissionRequests: noop,
      pendingViewSessionRef: { current: null },
      onSessionInactive,
      sessionStore,
    }));

    act(() => {
      mocks.listener?.({
        kind: 'status',
        sessionId: 'cron:task-1',
        runId: 'run-new',
        text: 'started',
      });
      mocks.listener?.({
        kind: 'complete',
        sessionId: 'cron:task-1',
        runId: 'run-old',
        exitCode: 0,
      });
      mocks.listener?.({
        kind: 'error',
        sessionId: 'cron:task-1',
        runId: 'run-old',
        terminal: true,
        code: 'gateway_disconnected',
      });
    });

    expect(setActiveRunId).toHaveBeenCalledWith('run-new');
    expect(setActiveRunId).not.toHaveBeenCalledWith(null);
    expect(sessionStore.cancelRunningActivities).not.toHaveBeenCalled();
    expect(setSessionRuntimeState).not.toHaveBeenCalledWith('inactive');
    expect(onSessionInactive).not.toHaveBeenCalled();
    expect(sessionStore.refreshFromServer).not.toHaveBeenCalled();
  });

  it('cancels running subagents only after session status confirms inactivity', () => {
    const sessionStore = createSessionStore();
    const setSessionRuntimeState = vi.fn();
    const setActiveRunId = vi.fn();
    renderHook(() => useChatRealtimeHandlers({
      provider,
      selectedProject: { name: 'project', fullPath: '/tmp/project' } as unknown as Project,
      selectedSession: { id: 'cron:task-1' } as unknown as ProjectSession,
      currentSessionId: 'cron:task-1',
      setCurrentSessionId: noop,
      setIsLoading: noop,
      setSessionRuntimeState,
      activeRunId: null,
      setActiveRunId,
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
      mocks.listener?.({
        type: 'session-status',
        sessionId: 'cron:task-1',
      });
    });
    expect(sessionStore.cancelRunningActivities).not.toHaveBeenCalled();
    expect(setSessionRuntimeState).not.toHaveBeenCalled();

    act(() => {
      mocks.listener?.({
        type: 'session-status',
        sessionId: 'cron:task-1',
        isProcessing: true,
        activeRunId: 'run-current',
      });
    });
    expect(sessionStore.cancelRunningActivities).not.toHaveBeenCalled();
    expect(setSessionRuntimeState).toHaveBeenLastCalledWith('running');
    expect(setActiveRunId).toHaveBeenLastCalledWith('run-current');

    act(() => {
      mocks.listener?.({
        type: 'session-status',
        sessionId: 'cron:task-1',
        isProcessing: false,
        expectedActiveRunId: 'run-current',
      });
    });
    expect(sessionStore.cancelRunningActivities).toHaveBeenCalledWith('cron:task-1');
    expect(setSessionRuntimeState).toHaveBeenLastCalledWith('inactive');
    expect(setActiveRunId).toHaveBeenLastCalledWith(null);
  });

  it('keeps active UI state and retries while session activity is unknown', () => {
    vi.useFakeTimers();
    const sessionStore = createSessionStore();
    const setSessionRuntimeState = vi.fn();
    const setIsLoading = vi.fn();
    const setCanAbortSession = vi.fn();
    const setActiveRunId = vi.fn();
    const onSessionInactive = vi.fn();
    const onSessionNotProcessing = vi.fn();
    const { unmount } = renderHook(() => useChatRealtimeHandlers({
      provider,
      selectedProject: { name: 'project', fullPath: '/tmp/project' } as unknown as Project,
      selectedSession: { id: 'cron:task-1' } as unknown as ProjectSession,
      currentSessionId: 'cron:task-1',
      setCurrentSessionId: noop,
      setIsLoading,
      setSessionRuntimeState,
      activeRunId: 'run-current',
      setActiveRunId,
      setCanAbortSession,
      setIsAborting: noop,
      setClaudeStatus: noop,
      setPilotDeckStatus: noop,
      setTokenBudget: noop,
      setPendingPermissionRequests: noop,
      pendingViewSessionRef: { current: null },
      onSessionInactive,
      onSessionNotProcessing,
      sessionStore,
    }));

    act(() => {
      mocks.listener?.({
        type: 'session-status',
        sessionId: 'cron:task-1',
        expectedActiveRunId: 'run-current',
        isProcessing: null,
      });
    });

    expect(setSessionRuntimeState).toHaveBeenLastCalledWith('synchronizing');
    expect(sessionStore.cancelRunningActivities).not.toHaveBeenCalled();
    expect(setActiveRunId).not.toHaveBeenCalled();
    expect(setIsLoading).not.toHaveBeenCalled();
    expect(setCanAbortSession).not.toHaveBeenCalled();
    expect(onSessionInactive).not.toHaveBeenCalled();
    expect(onSessionNotProcessing).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: 'check-session-status',
      sessionId: 'cron:task-1',
      provider: 'pilotdeck',
      expectedActiveRunId: 'run-current',
      includeActiveTurnMessages: true,
      statusRequestId: 1,
    });

    unmount();
    vi.useRealTimers();
  });

  it('does not keep retrying an unknown status after the session is no longer active', () => {
    vi.useFakeTimers();
    const sessionStore = createSessionStore();
    const { unmount } = renderHook(() => useChatRealtimeHandlers({
      provider,
      selectedProject: { name: 'project', fullPath: '/tmp/project' } as unknown as Project,
      selectedSession: { id: 'cron:task-2' } as unknown as ProjectSession,
      currentSessionId: 'cron:task-2',
      setCurrentSessionId: noop,
      setIsLoading: noop,
      setSessionRuntimeState: noop,
      activeRunId: null,
      setActiveRunId: noop,
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
      mocks.listener?.({
        type: 'session-status',
        sessionId: 'cron:task-1',
        isProcessing: null,
      });
      vi.advanceTimersByTime(1200);
    });

    expect(mocks.sendMessage).not.toHaveBeenCalled();

    unmount();
    vi.useRealTimers();
  });

  it('ignores an inactive status response requested for a superseded run', () => {
    const sessionStore = createSessionStore();
    const setSessionRuntimeState = vi.fn();
    const setActiveRunId = vi.fn();
    const onSessionInactive = vi.fn();
    renderHook(() => useChatRealtimeHandlers({
      provider,
      selectedProject: { name: 'project', fullPath: '/tmp/project' } as unknown as Project,
      selectedSession: { id: 'cron:task-1' } as unknown as ProjectSession,
      currentSessionId: 'cron:task-1',
      setCurrentSessionId: noop,
      setIsLoading: noop,
      setSessionRuntimeState,
      activeRunId: null,
      setActiveRunId,
      setCanAbortSession: noop,
      setIsAborting: noop,
      setClaudeStatus: noop,
      setPilotDeckStatus: noop,
      setTokenBudget: noop,
      setPendingPermissionRequests: noop,
      pendingViewSessionRef: { current: null },
      onSessionInactive,
      sessionStore,
    }));

    act(() => {
      mocks.listener?.({
        kind: 'status',
        sessionId: 'cron:task-1',
        runId: 'run-new',
        text: 'started',
      });
    });
    act(() => {
      mocks.listener?.({
        type: 'session-status',
        sessionId: 'cron:task-1',
        isProcessing: false,
        expectedActiveRunId: 'run-old',
      });
    });

    expect(setActiveRunId).toHaveBeenCalledWith('run-new');
    expect(setActiveRunId).not.toHaveBeenCalledWith(null);
    expect(sessionStore.cancelRunningActivities).not.toHaveBeenCalled();
    expect(setSessionRuntimeState).not.toHaveBeenCalledWith('inactive');
    expect(onSessionInactive).not.toHaveBeenCalled();

    act(() => {
      mocks.listener?.({
        type: 'session-status',
        sessionId: 'cron:task-1',
        isProcessing: false,
        expectedActiveRunId: 'run-new',
      });
    });

    expect(sessionStore.cancelRunningActivities).toHaveBeenCalledWith('cron:task-1');
    expect(setSessionRuntimeState).toHaveBeenLastCalledWith('inactive');
    expect(setActiveRunId).toHaveBeenLastCalledWith(null);
  });

  it('ignores a stale running response after a newer run starts', () => {
    const staleRequest = buildSessionStatusRequest({
      sessionId: 'cron:task-1',
      provider,
      expectedActiveRunId: null,
      includeActiveTurnMessages: true,
    });
    const sessionStore = createSessionStore();
    const setActiveRunId = vi.fn();
    const setSessionRuntimeState = vi.fn();
    renderHook(() => useChatRealtimeHandlers({
      provider,
      selectedProject: { name: 'project', fullPath: '/tmp/project' } as unknown as Project,
      selectedSession: { id: 'cron:task-1' } as unknown as ProjectSession,
      currentSessionId: 'cron:task-1',
      setCurrentSessionId: noop,
      setIsLoading: noop,
      setSessionRuntimeState,
      activeRunId: null,
      setActiveRunId,
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
      mocks.listener?.({
        kind: 'status',
        sessionId: 'cron:task-1',
        runId: 'run-new',
        text: 'started',
      });
    });
    vi.mocked(sessionStore.appendRealtime).mockClear();

    act(() => {
      mocks.listener?.({
        type: 'session-status',
        sessionId: 'cron:task-1',
        statusRequestId: staleRequest.statusRequestId,
        expectedActiveRunId: null,
        isProcessing: true,
        activeRunId: 'run-old',
        activeTurnMessages: [{
          id: 'stale-tool',
          kind: 'tool_use',
          sessionId: 'cron:task-1',
          runId: 'run-old',
          toolId: 'stale-tool',
          toolName: 'agent',
        }],
        activitySnapshot: [{
          id: 'stale-activity',
          kind: 'agent_activity',
          sessionId: 'cron:task-1',
          runId: 'subagent:old',
          state: 'running',
        }],
      });
    });

    expect(setActiveRunId).toHaveBeenCalledWith('run-new');
    expect(setActiveRunId).not.toHaveBeenCalledWith('run-old');
    expect(setSessionRuntimeState).not.toHaveBeenCalledWith('running');
    expect(sessionStore.appendRealtime).not.toHaveBeenCalled();
    expect(sessionStore.setActivities).not.toHaveBeenCalled();
  });

  it('does not resurrect a completed run from an older status response', () => {
    const sessionStore = createSessionStore();
    const setActiveRunId = vi.fn();
    const setSessionRuntimeState = vi.fn();
    renderHook(() => useChatRealtimeHandlers({
      provider,
      selectedProject: { name: 'project', fullPath: '/tmp/project' } as unknown as Project,
      selectedSession: { id: 'cron:task-1' } as unknown as ProjectSession,
      currentSessionId: 'cron:task-1',
      setCurrentSessionId: noop,
      setIsLoading: noop,
      setSessionRuntimeState,
      activeRunId: 'run-current',
      setActiveRunId,
      setCanAbortSession: noop,
      setIsAborting: noop,
      setClaudeStatus: noop,
      setPilotDeckStatus: noop,
      setTokenBudget: noop,
      setPendingPermissionRequests: noop,
      pendingViewSessionRef: { current: null },
      sessionStore,
    }));
    const olderRequest = buildSessionStatusRequest({
      sessionId: 'cron:task-1',
      provider,
      expectedActiveRunId: 'run-current',
      includeActiveTurnMessages: false,
    });
    const newerRequest = buildSessionStatusRequest({
      sessionId: 'cron:task-1',
      provider,
      expectedActiveRunId: 'run-current',
      includeActiveTurnMessages: false,
    });

    act(() => {
      mocks.listener?.({
        type: 'session-status',
        sessionId: 'cron:task-1',
        statusRequestId: newerRequest.statusRequestId,
        expectedActiveRunId: 'run-current',
        isProcessing: false,
      });
      mocks.listener?.({
        type: 'session-status',
        sessionId: 'cron:task-1',
        statusRequestId: olderRequest.statusRequestId,
        expectedActiveRunId: 'run-current',
        isProcessing: true,
        activeRunId: 'run-current',
      });
    });

    expect(sessionStore.cancelRunningActivities).toHaveBeenCalledTimes(1);
    expect(setSessionRuntimeState).toHaveBeenLastCalledWith('inactive');
    expect(setSessionRuntimeState).not.toHaveBeenCalledWith('running');
    expect(setActiveRunId).toHaveBeenCalledTimes(1);
    expect(setActiveRunId).toHaveBeenCalledWith(null);
  });

  it('ignores an older inactive response even when it arrives before the latest response', () => {
    const sessionStore = createSessionStore();
    const setActiveRunId = vi.fn();
    const setSessionRuntimeState = vi.fn();
    renderHook(() => useChatRealtimeHandlers({
      provider,
      selectedProject: { name: 'project', fullPath: '/tmp/project' } as unknown as Project,
      selectedSession: { id: 'cron:task-1' } as unknown as ProjectSession,
      currentSessionId: 'cron:task-1',
      setCurrentSessionId: noop,
      setIsLoading: noop,
      setSessionRuntimeState,
      activeRunId: 'run-current',
      setActiveRunId,
      setCanAbortSession: noop,
      setIsAborting: noop,
      setClaudeStatus: noop,
      setPilotDeckStatus: noop,
      setTokenBudget: noop,
      setPendingPermissionRequests: noop,
      pendingViewSessionRef: { current: null },
      sessionStore,
    }));
    const olderRequest = buildSessionStatusRequest({
      sessionId: 'cron:task-1',
      provider,
      expectedActiveRunId: 'run-current',
      includeActiveTurnMessages: false,
    });
    const latestRequest = buildSessionStatusRequest({
      sessionId: 'cron:task-1',
      provider,
      expectedActiveRunId: 'run-current',
      includeActiveTurnMessages: false,
    });

    act(() => {
      mocks.listener?.({
        type: 'session-status',
        sessionId: 'cron:task-1',
        statusRequestId: olderRequest.statusRequestId,
        expectedActiveRunId: 'run-current',
        isProcessing: false,
      });
    });

    expect(sessionStore.cancelRunningActivities).not.toHaveBeenCalled();
    expect(setSessionRuntimeState).not.toHaveBeenCalledWith('inactive');
    expect(setActiveRunId).not.toHaveBeenCalledWith(null);

    act(() => {
      mocks.listener?.({
        type: 'session-status',
        sessionId: 'cron:task-1',
        statusRequestId: latestRequest.statusRequestId,
        expectedActiveRunId: 'run-current',
        isProcessing: true,
        activeRunId: 'run-current',
      });
    });

    expect(sessionStore.cancelRunningActivities).not.toHaveBeenCalled();
    expect(setSessionRuntimeState).toHaveBeenLastCalledWith('running');
    expect(setActiveRunId).toHaveBeenLastCalledWith('run-current');
  });
});
