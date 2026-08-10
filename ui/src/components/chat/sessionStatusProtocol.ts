type SessionStatusRequestOptions = {
  sessionId: string;
  provider: string;
  expectedActiveRunId: string | null;
  includeActiveTurnMessages: boolean;
};

type SessionStatusSequence = {
  latestIssued: number;
  latestIssuedAt: number;
  invalidThrough: number;
  lastHandled: number;
};

const statusSequenceBySession = new Map<string, SessionStatusSequence>();
let nextStatusRequestId = 0;
const STATUS_REQUEST_STALE_AFTER_MS = 15_000;

function getOrCreateStatusSequence(sessionId: string): SessionStatusSequence {
  const existing = statusSequenceBySession.get(sessionId);
  if (existing) return existing;

  const created = {
    latestIssued: 0,
    latestIssuedAt: 0,
    invalidThrough: 0,
    lastHandled: 0,
  };
  statusSequenceBySession.set(sessionId, created);
  return created;
}

export function buildSessionStatusRequest({
  sessionId,
  provider,
  expectedActiveRunId,
  includeActiveTurnMessages,
}: SessionStatusRequestOptions) {
  nextStatusRequestId += 1;
  const sequence = getOrCreateStatusSequence(sessionId);
  sequence.latestIssued = nextStatusRequestId;
  sequence.latestIssuedAt = Date.now();

  return {
    type: 'check-session-status',
    sessionId,
    provider,
    expectedActiveRunId,
    includeActiveTurnMessages,
    statusRequestId: nextStatusRequestId,
  };
}

export function buildSessionStatusRequestIfIdle(options: SessionStatusRequestOptions) {
  const sequence = getOrCreateStatusSequence(options.sessionId);
  const hasPendingRequest = sequence.latestIssued > sequence.invalidThrough
    && sequence.latestIssued > sequence.lastHandled;
  if (hasPendingRequest && Date.now() - sequence.latestIssuedAt < STATUS_REQUEST_STALE_AFTER_MS) {
    return null;
  }
  if (hasPendingRequest) {
    sequence.invalidThrough = Math.max(sequence.invalidThrough, sequence.latestIssued);
  }
  return buildSessionStatusRequest(options);
}

export function shouldAcceptSessionStatusResponse(
  sessionId: string,
  statusRequestId: unknown,
): boolean {
  const sequence = statusSequenceBySession.get(sessionId);

  // Compatibility for unsolicited responses from an older server. Once this
  // client has issued a sequenced request for the session, every response must
  // echo its sequence so stale replies cannot mutate the active turn.
  if (!sequence) return statusRequestId == null;
  if (!Number.isSafeInteger(statusRequestId)) return false;

  const requestId = statusRequestId as number;
  if (
    requestId !== sequence.latestIssued
    || requestId <= sequence.invalidThrough
    || requestId <= sequence.lastHandled
  ) {
    return false;
  }

  sequence.lastHandled = requestId;
  return true;
}

export function invalidateSessionStatusResponses(sessionId: string): void {
  const sequence = statusSequenceBySession.get(sessionId);
  if (!sequence) return;
  sequence.invalidThrough = Math.max(sequence.invalidThrough, sequence.latestIssued);
}

export function resetSessionStatusProtocolForTests(): void {
  statusSequenceBySession.clear();
  nextStatusRequestId = 0;
}
