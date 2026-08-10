import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSessionStatusProtocolForTests } from '../chat/sessionStatusProtocol';
import {
  buildReconnectStatusMessage,
  refreshSessionAfterReconnect,
  shouldRefreshSessionOnReconnect,
} from './reconnectRecovery';

describe('ChatInterfaceV2 reconnect recovery helpers', () => {
  beforeEach(() => {
    resetSessionStatusProtocolForTests();
  });

  it('requests active turn messages when checking session status after reconnect', () => {
    expect(buildReconnectStatusMessage('session-1', 'run-current')).toEqual({
      type: 'check-session-status',
      sessionId: 'session-1',
      provider: 'pilotdeck',
      expectedActiveRunId: 'run-current',
      includeActiveTurnMessages: true,
      statusRequestId: 1,
    });
  });

  it('skips full refresh while the current session is processing', () => {
    expect(shouldRefreshSessionOnReconnect({
      isLoading: false,
      processingSessions: new Set(['session-1']),
      sessionId: 'session-1',
    })).toBe(false);
  });

  it('skips full refresh while the UI is loading', () => {
    expect(shouldRefreshSessionOnReconnect({
      isLoading: true,
      processingSessions: new Set(),
      sessionId: 'session-1',
    })).toBe(false);
  });

  it('allows full refresh for inactive sessions', () => {
    expect(shouldRefreshSessionOnReconnect({
      isLoading: false,
      processingSessions: new Set(['session-2']),
      sessionId: 'session-1',
    })).toBe(true);
  });

  it('does not throw when reconnect refresh fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(refreshSessionAfterReconnect(async () => {
      throw new Error('refresh failed');
    })).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      'Error refreshing session after WebSocket reconnect:',
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});
