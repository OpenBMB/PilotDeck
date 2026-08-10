import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSessionStatusRequest,
  buildSessionStatusRequestIfIdle,
  invalidateSessionStatusResponses,
  resetSessionStatusProtocolForTests,
  shouldAcceptSessionStatusResponse,
} from './sessionStatusProtocol';

const options = {
  sessionId: 'session-1',
  provider: 'pilotdeck',
  expectedActiveRunId: 'run-1',
  includeActiveTurnMessages: true,
};

describe('session status request sequencing', () => {
  beforeEach(() => {
    resetSessionStatusProtocolForTests();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps only one request in flight per session', () => {
    const request = buildSessionStatusRequestIfIdle(options);

    expect(request).not.toBeNull();
    expect(buildSessionStatusRequestIfIdle(options)).toBeNull();
    expect(shouldAcceptSessionStatusResponse('session-1', request?.statusRequestId)).toBe(true);
    expect(buildSessionStatusRequestIfIdle(options)?.statusRequestId).toBe(2);
  });

  it('rejects an invalidated response after a newer request is issued', () => {
    const olderRequest = buildSessionStatusRequest(options);
    invalidateSessionStatusResponses('session-1');
    const latestRequest = buildSessionStatusRequestIfIdle(options);

    expect(latestRequest?.statusRequestId).toBe(2);
    expect(shouldAcceptSessionStatusResponse('session-1', olderRequest.statusRequestId)).toBe(false);
    expect(shouldAcceptSessionStatusResponse('session-1', latestRequest?.statusRequestId)).toBe(true);
  });

  it('replaces a request that has received no response within the stale timeout', () => {
    vi.useFakeTimers();
    const olderRequest = buildSessionStatusRequestIfIdle(options);

    vi.advanceTimersByTime(15_000);
    const latestRequest = buildSessionStatusRequestIfIdle(options);

    expect(latestRequest?.statusRequestId).toBe(2);
    expect(shouldAcceptSessionStatusResponse('session-1', olderRequest?.statusRequestId)).toBe(false);
    expect(shouldAcceptSessionStatusResponse('session-1', latestRequest?.statusRequestId)).toBe(true);
  });
});
