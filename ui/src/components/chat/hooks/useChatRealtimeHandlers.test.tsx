import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';
import { useSessionStore, type SessionStore } from '../../../stores/useSessionStore';
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
afterEach(cleanup);

function createSessionStore() {
  return {
    cancelRunningActivities: vi.fn(),
    refreshFromServer: vi.fn().mockResolvedValue(undefined),
    setActiveSession: vi.fn(),
    finalizeStreaming: vi.fn(),
    finalizeStreamingThinking: vi.fn(),
    appendRealtime: vi.fn(),
    closeTimeline: vi.fn(),
    applyTimelineMessage: vi.fn(),
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

  it.each(['thinking', 'stream_delta'])('starts a separate %s block when compaction begins', (kind) => {
    const { result } = renderHook(() => useSessionStore());
    const sessionStore = result.current;
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
      const base = { sessionId: 'web:s_test', runId: 'run-1', provider };
      mocks.listener?.({ ...base, kind, content: 'Before compact' });
      mocks.listener?.({ ...base, id: 'compact', kind: 'status', text: 'compacting', compactProgress: { compaction_id: 'c1', state: 'running', stage: 'summary', label: 'Summarizing', level: 1 } });
      mocks.listener?.({ ...base, kind, content: 'After compact' });
    });
    const messages = sessionStore.getMessages('web:s_test');
    expect(messages.map(message => message.kind)).toEqual([kind === 'thinking' ? 'thinking' : 'text', 'compact_boundary', kind]);
    expect(messages[0]).toMatchObject({ content: 'Before compact', isFinal: true });
    expect(messages[2].content).toBe('After compact');
  });

  it.each([false, true])('preserves first WS child termination and error details (existing cache: %s)', async (cached) => {
    // Load the Node bridge at runtime without adding its backend dependencies
    // to the browser TypeScript project. Exercise the real transport mapping.
    const bridgePath = '../../../../server/pilotdeck-bridge.js';
    const { gatewayEventToFrames } = await import(bridgePath) as {
      gatewayEventToFrames: (event: Record<string, unknown>, sessionId: string, provider: SessionProvider) => unknown[];
    };
    const { result } = renderHook(useSessionStore);
    const sessionStore = result.current;
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

    const child = { type: 'agent_status', runId: 'run-1', event: 'subagent_thinking_delta',
      timeline: { version: 1, turnId: 'child-t0', id: 'thought', order: 0, revision: 1 },
      streamState: 'open', detail: { subagentId: 'child', text: 'Restored thought' } };
    const deliver = (event: Parameters<typeof gatewayEventToFrames>[0]) => {
      for (const frame of gatewayEventToFrames(event, 'web:s_test', provider)) mocks.listener?.(frame);
    };
    act(() => {
      if (cached) deliver(child);
      deliver({ type: 'agent_status', runId: 'run-1', event: 'subagent_model_error',
        detail: { subagentId: 'child', message: 'Timeout detail' } });
      deliver({ type: 'agent_status', runId: 'run-1', event: 'subagent_completed',
        detail: { subagentId: 'child', errored: true } });
      deliver(child);
    });
    const detail = sessionStore.getSubagentDetailMessages('web:s_test', 'child');
    expect(detail.find(m => m.kind === 'error')?.content).toBe('Timeout detail');
    expect(detail.find(m => m.kind === 'thinking')).toMatchObject({ content: 'Restored thought', streamState: 'closed' });
  }, 15_000);

  it.each(['completed', 'failed', 'cancelled'])('closes child detail on %s using its parent run identity', (state) => {
    const { result } = renderHook(useSessionStore);
    const sessionStore = result.current;
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
      const base = { sessionId: 'web:s_test', runId: 'run-1', provider };
      mocks.listener?.({ ...base, id: 'parent', kind: 'thinking', content: 'Parent thought',
        timeline: { version: 1, turnId: 'run-1', id: 'parent', order: 0, revision: 1, offset: 0 } });
      mocks.listener?.({ ...base, id: 'child', kind: 'thinking', content: 'Child thought',
        subagentId: 'child', isSubagentDetail: true,
        timeline: { version: 1, turnId: 'child-t0', id: 'thought', order: 0, revision: 1, offset: 0 } });
      mocks.listener?.({ ...base, id: 'activity', kind: 'agent_activity', phase: 'subagent',
        state, subagentId: 'child', parentRunId: 'run-1', runId: 'subagent:child' });
    });
    expect(sessionStore.getSubagentDetailMessages('web:s_test', 'child')[0].streamState).toBe('closed');
    expect(sessionStore.getMessages('web:s_test').find(m => m.kind === 'thinking')?.streamState).toBe('open');
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
