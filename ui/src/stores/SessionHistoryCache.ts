import type { SessionSlot } from './useSessionStore';

/**
 * Bound disposable history snapshots, not live conversation state. Once a slot
 * receives a live mutation it stays pinned: a successful HTTP response alone
 * does not prove that every optimistic/timeline update has reached the transcript.
 */
export class SessionHistoryCache {
  readonly slots = new Map<string, SessionSlot>();
  private readonly live = new WeakSet<SessionSlot>();
  private readonly confirmed = new Map<string, SessionSlot>();
  private readonly loading = new Map<string, number>();
  private activeSessionId: string | null = null;

  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId;
    const slot = sessionId ? this.confirmed.get(sessionId) : undefined;
    if (sessionId && slot) {
      this.confirmed.delete(sessionId);
      this.confirmed.set(sessionId, slot);
    }
    this.prune();
  }

  markLive(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    if (slot) this.live.add(slot);
    this.confirmed.delete(sessionId);
  }

  beginHistory(sessionId: string): void {
    this.loading.set(sessionId, (this.loading.get(sessionId) ?? 0) + 1);
    this.confirmed.delete(sessionId);
  }

  confirmHistory(sessionId: string, slot: SessionSlot, hasStreamSnapshot: boolean): void {
    if (hasStreamSnapshot) this.markLive(sessionId);
    if (this.slots.get(sessionId) !== slot || this.live.has(slot)
      || slot.status !== 'idle' || slot._serverLoadingGeneration !== null
      || slot.realtimeMessages.length > 0 || slot.activityMessages.length > 0
      || slot.subagentDetailMessages.size > 0 || slot.subagentLinks.size > 0
      || slot.timeline?.hasGap || slot.timeline?.values(null).some(message => message.streamState === 'open')) return;

    // Historical tool calls without their results and explicit prompt requests
    // may still be pending. Keep them even if no stream frame arrived locally.
    const pendingTools = new Set<string>();
    for (const message of slot.serverMessages) {
      if (message.kind === 'permission_request' || message.kind === 'interactive_prompt'
        || (message.kind === 'stream_delta' && !message.isFinal)) return;
      if (message.kind === 'tool_use') {
        if (!message.toolId) return;
        pendingTools.add(message.toolId);
      }
      if (message.kind === 'tool_result' && message.toolId) pendingTools.delete(message.toolId);
    }
    if (pendingTools.size > 0) return;
    this.confirmed.delete(sessionId);
    this.confirmed.set(sessionId, slot);
  }

  endHistory(sessionId: string): void {
    const remaining = (this.loading.get(sessionId) ?? 1) - 1;
    if (remaining > 0) this.loading.set(sessionId, remaining);
    else this.loading.delete(sessionId);
    this.prune();
  }

  private prune(): void {
    const inactive = [...this.confirmed.keys()]
      .filter(id => id !== this.activeSessionId && !this.loading.has(id));
    for (const id of inactive.slice(0, Math.max(0, inactive.length - 8))) {
      const slot = this.confirmed.get(id);
      this.confirmed.delete(id);
      if (this.slots.get(id) === slot) this.slots.delete(id);
    }
  }
}
