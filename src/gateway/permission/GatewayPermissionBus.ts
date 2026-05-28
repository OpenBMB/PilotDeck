/**
 * In-process pending-request store for Web permission round-trips.
 *
 * Mirrors {@link import("../elicitation/GatewayElicitationBus.js").GatewayElicitationBus}
 * but for `permission_request` events: a tool that needs UI confirmation
 * registers a pending entry; the Web UI eventually calls
 * `Gateway.permissionDecide({ requestId, decision })` and the bus resolves.
 *
 * One bus per process, keyed by `sessionKey`. Pending entries are dropped
 * (rejected) when the turn ends so leaked promises do not hang.
 */

export type GatewayPermissionDecision = {
  requestId: string;
  decision: "allow" | "deny";
  remember?: boolean;
  reason?: string;
};

export type GatewayPermissionPending = {
  requestId: string;
  toolCallId: string;
  toolName: string;
  resolve(decision: GatewayPermissionDecision): void;
  reject(error: Error): void;
};

export class GatewayPermissionBus {
  private readonly bySession = new Map<string, Map<string, GatewayPermissionPending>>();

  register(sessionKey: string, entry: GatewayPermissionPending): void {
    let bucket = this.bySession.get(sessionKey);
    if (!bucket) {
      bucket = new Map();
      this.bySession.set(sessionKey, bucket);
    }
    bucket.set(entry.requestId, entry);
  }

  consume(sessionKey: string, requestId: string): GatewayPermissionPending | undefined {
    const bucket = this.bySession.get(sessionKey);
    if (!bucket) return undefined;
    const entry = bucket.get(requestId);
    if (!entry) return undefined;
    bucket.delete(requestId);
    if (bucket.size === 0) this.bySession.delete(sessionKey);
    return entry;
  }

  hasPending(sessionKey: string, requestId: string): boolean {
    return this.bySession.get(sessionKey)?.has(requestId) ?? false;
  }

  rejectSession(sessionKey: string, reason: string): void {
    const bucket = this.bySession.get(sessionKey);
    if (!bucket) return;
    for (const entry of bucket.values()) {
      entry.reject(new Error(reason));
    }
    this.bySession.delete(sessionKey);
  }

  pendingCount(sessionKey: string): number {
    return this.bySession.get(sessionKey)?.size ?? 0;
  }
}
