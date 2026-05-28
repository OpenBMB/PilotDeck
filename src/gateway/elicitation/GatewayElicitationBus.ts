/**
 * In-process pending-request store for elicitation round-trips. Per-session.
 *
 * Behaviour parity with the legacy upstream elicitation handler:
 *   - One bus per session — concurrent tool calls within a session share the
 *     same map.
 *   - Each entry tracks `(resolve, reject, signal-listener)` so an aborted
 *     turn rejects pending askUser() calls instead of leaking them.
 *   - The bus is intentionally untyped about transport: callers (gateway,
 *     channel) own their own event/payload shapes and just use the bus to
 *     bridge promise-resolution.
 */

import type { PilotDeckElicitationAnswer } from "../../tool/elicitation/PilotDeckElicitationChannel.js";

export type GatewayElicitationPending = {
  requestId: string;
  toolCallId: string;
  toolName: string;
  resolve(answer: PilotDeckElicitationAnswer): void;
  reject(error: Error): void;
};

/**
 * Per-process registry: one map per `sessionKey`.
 * Singleton lifetime — owned by the `InProcessGateway`.
 */
export class GatewayElicitationBus {
  private readonly bySession = new Map<string, Map<string, GatewayElicitationPending>>();

  register(sessionKey: string, entry: GatewayElicitationPending): void {
    let bucket = this.bySession.get(sessionKey);
    if (!bucket) {
      bucket = new Map();
      this.bySession.set(sessionKey, bucket);
    }
    bucket.set(entry.requestId, entry);
  }

  /** Returns the matching entry and removes it from the bucket. */
  consume(sessionKey: string, requestId: string): GatewayElicitationPending | undefined {
    const bucket = this.bySession.get(sessionKey);
    if (!bucket) return undefined;
    const entry = bucket.get(requestId);
    if (!entry) return undefined;
    bucket.delete(requestId);
    if (bucket.size === 0) this.bySession.delete(sessionKey);
    return entry;
  }

  /** True while a host response is still expected for this request. */
  hasPending(sessionKey: string, requestId: string): boolean {
    return this.bySession.get(sessionKey)?.has(requestId) ?? false;
  }

  /**
   * Reject and drop every pending entry for a session. Called when a turn
   * ends (success / error / abort) so leaked askUser promises are surfaced
   * with a clear reason rather than hanging indefinitely.
   */
  rejectSession(sessionKey: string, reason: string): void {
    const bucket = this.bySession.get(sessionKey);
    if (!bucket) return;
    for (const entry of bucket.values()) {
      entry.reject(new Error(reason));
    }
    this.bySession.delete(sessionKey);
  }

  /** For tests / debugging. */
  pendingCount(sessionKey: string): number {
    return this.bySession.get(sessionKey)?.size ?? 0;
  }
}
