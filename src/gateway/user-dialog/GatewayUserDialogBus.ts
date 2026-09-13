import { randomUUID } from "node:crypto";

import type { GatewayUserDialogRequestEvent } from "../protocol/types.js";

export type GatewayUserDialogKind = "input" | "select" | "confirm" | "form";

export type GatewayUserDialogAnswer =
  | { type: "answered"; value: unknown }
  | { type: "cancelled"; reason?: string };

export type GatewayUserDialogPending = {
  requestId: string;
  dialogKind: GatewayUserDialogKind;
  toolCallId: string;
  toolName: string;
  /** Immutable request snapshot exposed to a reconnecting host renderer. */
  event: GatewayUserDialogRequestEvent;
  /** Validates answered values without consuming a still-pending dialog. */
  accepts(value: unknown): boolean;
  resolve(answer: GatewayUserDialogAnswer): void;
  reject(error: Error): void;
  /** Removes the durable pending record before an answer can resume a tool. */
  onSettled?(): void;
};

export type GatewayUserDialogLease = {
  leaseId: string;
  expiresAt: string;
};

export type GatewayUserDialogLeaseClaim =
  | { claimed: true; lease: GatewayUserDialogLease }
  | { claimed: false; reason: "claimed" | "not_pending"; expiresAt?: string };

/**
 * A non-authoritative change hint for remote renderers. The pending request,
 * lease and answer validation state remain in this bus; consumers that need
 * a snapshot must still call the Gateway list RPC.
 */
export type GatewayUserDialogChange =
  | {
      type: "requested";
      sessionKey: string;
      projectKey?: string;
      request: GatewayUserDialogRequestEvent;
    }
  | {
      type: "lease_changed";
      sessionKey: string;
      projectKey?: string;
      requestId: string;
      action: "claimed" | "released" | "expired";
      expiresAt?: string;
    }
  | {
      type: "settled";
      sessionKey: string;
      projectKey?: string;
      requestId: string;
      reason: string;
    };

export type GatewayUserDialogConsumeResult =
  | { entry: GatewayUserDialogPending }
  | { entry: undefined; reason: "not_pending" | "lease_required" };

export type GatewayUserDialogBusOptions = {
  now?: () => Date;
  uuid?: () => string;
  /** Called after a Gateway-owned dialog state mutation. */
  onChange?: (change: GatewayUserDialogChange) => void;
};

type ActiveLease = GatewayUserDialogLease & { expiresAtMs: number };

/** Gateway-owned, per-session pending generic dialog store. */
export class GatewayUserDialogBus {
  private readonly bySession = new Map<string, Map<string, GatewayUserDialogPending>>();
  private readonly leases = new Map<string, Map<string, ActiveLease>>();
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly onChange?: (change: GatewayUserDialogChange) => void;

  constructor(options: GatewayUserDialogBusOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.onChange = options.onChange;
  }

  register(sessionKey: string, entry: GatewayUserDialogPending): void {
    let bucket = this.bySession.get(sessionKey);
    if (!bucket) {
      bucket = new Map();
      this.bySession.set(sessionKey, bucket);
    }
    bucket.set(entry.requestId, entry);
    this.emitChange({
      type: "requested",
      sessionKey,
      request: structuredClone(entry.event),
    });
  }

  consume(sessionKey: string, requestId: string, reason = "settled"): GatewayUserDialogPending | undefined {
    const bucket = this.bySession.get(sessionKey);
    if (!bucket) return undefined;
    const entry = bucket.get(requestId);
    if (!entry) return undefined;
    this.remove(sessionKey, requestId, entry, reason);
    return entry;
  }

  /**
   * Resolves a dialog for an external renderer. A live lease is optional for
   * backwards compatibility, but when one exists its opaque id is required.
   * Native abort/turn cleanup intentionally continues to use `consume()` so
   * it cannot be held hostage by a disconnected renderer.
   */
  consumeForResponse(
    sessionKey: string,
    requestId: string,
    leaseId?: string,
    reason = "answered",
  ): GatewayUserDialogConsumeResult {
    const bucket = this.bySession.get(sessionKey);
    const entry = bucket?.get(requestId);
    if (!entry) return { entry: undefined, reason: "not_pending" };
    const lease = this.activeLease(sessionKey, requestId);
    if (lease && lease.leaseId !== leaseId) {
      return { entry: undefined, reason: "lease_required" };
    }
    this.remove(sessionKey, requestId, entry, reason);
    return { entry };
  }

  peek(sessionKey: string, requestId: string): GatewayUserDialogPending | undefined {
    return this.bySession.get(sessionKey)?.get(requestId);
  }

  hasPending(sessionKey: string, requestId: string): boolean {
    return this.bySession.get(sessionKey)?.has(requestId) ?? false;
  }

  /**
   * Atomically reserves a live dialog for one renderer. The Gateway exposes
   * only expiry metadata through list(), never the bearer lease id.
   */
  claim(sessionKey: string, requestId: string, ttlMs: number, renewLeaseId?: string): GatewayUserDialogLeaseClaim {
    const entry = this.peek(sessionKey, requestId);
    if (!entry) return { claimed: false, reason: "not_pending" };
    const existing = this.activeLease(sessionKey, requestId);
    if (existing && existing.leaseId !== renewLeaseId) {
      return { claimed: false, reason: "claimed", expiresAt: existing.expiresAt };
    }
    const expiresAtMs = this.now().getTime() + ttlMs;
    const lease: ActiveLease = {
      leaseId: existing?.leaseId ?? this.uuid(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
    };
    let sessionLeases = this.leases.get(sessionKey);
    if (!sessionLeases) {
      sessionLeases = new Map();
      this.leases.set(sessionKey, sessionLeases);
    }
    sessionLeases.set(requestId, lease);
    this.emitChange({
      type: "lease_changed",
      sessionKey,
      requestId,
      action: "claimed",
      expiresAt: lease.expiresAt,
    });
    return { claimed: true, lease: { leaseId: lease.leaseId, expiresAt: lease.expiresAt } };
  }

  /** Releases a matching live lease without changing the pending dialog. */
  release(sessionKey: string, requestId: string, leaseId: string): boolean {
    const lease = this.activeLease(sessionKey, requestId);
    if (!lease || lease.leaseId !== leaseId) return false;
    this.deleteLease(sessionKey, requestId);
    this.emitChange({ type: "lease_changed", sessionKey, requestId, action: "released" });
    return true;
  }

  /** Returns copies so a renderer cannot mutate the Gateway-owned contract. */
  list(sessionKey: string): Array<GatewayUserDialogRequestEvent & { lease?: { expiresAt: string } }> {
    return [...(this.bySession.get(sessionKey)?.values() ?? [])]
      .map((entry) => {
        const lease = this.activeLease(sessionKey, entry.requestId);
        return {
          ...structuredClone(entry.event),
          ...(lease ? { lease: { expiresAt: lease.expiresAt } } : {}),
        };
      });
  }

  rejectSession(sessionKey: string, reason: string): void {
    const bucket = this.bySession.get(sessionKey);
    if (!bucket) return;
    for (const entry of bucket.values()) {
      try {
        entry.onSettled?.();
      } catch {
        // Turn cleanup must still release a blocked native tool. A stale
        // journal is later surfaced as a conservative restart termination.
      }
      entry.reject(new Error(reason));
      this.emitChange({ type: "settled", sessionKey, requestId: entry.requestId, reason });
    }
    this.bySession.delete(sessionKey);
    this.leases.delete(sessionKey);
  }

  pendingCount(sessionKey: string): number {
    return this.bySession.get(sessionKey)?.size ?? 0;
  }

  private remove(sessionKey: string, requestId: string, entry: GatewayUserDialogPending, reason: string): void {
    entry.onSettled?.();
    const bucket = this.bySession.get(sessionKey);
    bucket?.delete(requestId);
    if (bucket?.size === 0) this.bySession.delete(sessionKey);
    this.deleteLease(sessionKey, requestId);
    this.emitChange({ type: "settled", sessionKey, requestId, reason });
  }

  private activeLease(sessionKey: string, requestId: string): ActiveLease | undefined {
    const lease = this.leases.get(sessionKey)?.get(requestId);
    if (!lease) return undefined;
    if (lease.expiresAtMs > this.now().getTime()) return lease;
    this.deleteLease(sessionKey, requestId);
    this.emitChange({ type: "lease_changed", sessionKey, requestId, action: "expired" });
    return undefined;
  }

  private deleteLease(sessionKey: string, requestId: string): void {
    const sessionLeases = this.leases.get(sessionKey);
    if (!sessionLeases) return;
    sessionLeases.delete(requestId);
    if (sessionLeases.size === 0) this.leases.delete(sessionKey);
  }

  private emitChange(change: GatewayUserDialogChange): void {
    try {
      this.onChange?.(change);
    } catch {
      // Renderer observation is best effort. It must never affect the
      // native dialog promise, response validation, or cleanup path.
    }
  }
}
