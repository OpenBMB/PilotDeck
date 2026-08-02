import { describe, expect, it } from 'vitest';
import { shouldConnectWebSocket } from './WebSocketContext';

describe('shouldConnectWebSocket', () => {
  it('waits for cookie-session restoration before connecting', () => {
    expect(shouldConnectWebSocket({ token: null, hasUser: false, isAuthLoading: true })).toBe(false);
  });

  it('does not reconnect on the login screen', () => {
    expect(shouldConnectWebSocket({ token: null, hasUser: false, isAuthLoading: false })).toBe(false);
  });

  it('connects after an authenticated or local session is ready', () => {
    expect(shouldConnectWebSocket({ token: 'cookie-session', hasUser: true, isAuthLoading: false })).toBe(true);
    expect(shouldConnectWebSocket({ token: 'local-session', hasUser: true, isAuthLoading: false })).toBe(true);
  });
});
