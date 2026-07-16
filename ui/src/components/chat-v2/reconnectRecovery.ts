export function shouldRefreshSessionOnReconnect({
  isLoading,
  processingSessions,
  sessionId,
}: {
  isLoading: boolean;
  processingSessions?: Set<string>;
  sessionId: string;
}): boolean {
  return !(isLoading || processingSessions?.has(sessionId));
}

export function buildReconnectStatusMessage(sessionId: string) {
  return {
    type: 'check-session-status',
    sessionId,
    provider: 'pilotdeck',
    includeActiveTurnMessages: true,
  };
}

export async function refreshSessionAfterReconnect(refresh: () => Promise<unknown>): Promise<void> {
  try {
    await refresh();
  } catch (error) {
    console.error('Error refreshing session after WebSocket reconnect:', error);
  }
}
