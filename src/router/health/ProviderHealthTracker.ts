import type { CanonicalModelError, ModelRuntime } from "../../model/index.js";
import type { RouterModelRef } from "../config/schema.js";

export type ProviderHealthState = "healthy" | "degraded" | "open" | "half_open";
export type RecoverySignal = "service" | "credential" | "task" | "cancelled" | "unknown";

const SERVICE_ERROR_CODES = new Set([
  "rate_limit_error", "server_error", "timeout", "overloaded_error", "dns_error",
  "connection_reset", "connection_refused", "tls_error", "proxy_error", "network_error",
]);
const TASK_ERROR_CODES = new Set([
  "invalid_tool_arguments", "invalid_request", "prompt_too_long", "request_too_large",
  "context_overflow", "image_too_large", "payload_too_large", "max_output_reached",
]);

export function classifyRecoverySignal(error: CanonicalModelError): RecoverySignal {
  if (error.code === "aborted" || error.code === "cancelled") return "cancelled";
  if (error.code === "auth_error" || error.code === "billing") return "credential";
  if (
    SERVICE_ERROR_CODES.has(error.code) ||
    error.status === 408 ||
    error.status === 409 ||
    error.status === 429 ||
    (error.status != null && error.status >= 500)
  ) {
    return "service";
  }
  if (TASK_ERROR_CODES.has(error.code)) return "task";
  return "unknown";
}

/** A non-secret identity for failures shared by provider aliases. */
export function providerFailureDomain(runtime: ModelRuntime, ref: RouterModelRef): string {
  const protocol = runtime.getProviderProtocol(ref.provider) ?? "unknown";
  const rawUrl = runtime.getProviderBaseUrl(ref.provider);
  if (!rawUrl) return `${protocol}|provider:${ref.provider}`;
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    return `${protocol}|${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}`;
  } catch {
    return `${protocol}|${rawUrl.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase()}`;
  }
}

type ProviderRecord = {
  state: ProviderHealthState;
  consecutiveFailures: number;
  openedAt: number;
  cooldownUntil: number;
  lastTouchedAt: number;
  halfOpenProbeInFlight: boolean;
  openCount: number;
  window: boolean[];
  latencyEwmaMs?: number;
};

export type ProviderHealthTrackerOptions = {
  degradeThreshold?: number;
  openThreshold?: number;
  openDurationMs?: number;
  maxOpenDurationMs?: number;
  recordTtlMs?: number;
  windowSize?: number;
  capacity?: number;
  now?: () => number;
};

/**
 * Runtime-scoped endpoint health memory. Only service failures belong here.
 * Success rate uses a Beta(2,2) prior so one cold sample cannot dominate.
 */
export class ProviderHealthTracker {
  private readonly records = new Map<string, ProviderRecord>();
  private readonly degradeThreshold: number;
  private readonly openThreshold: number;
  private readonly openDurationMs: number;
  private readonly maxOpenDurationMs: number;
  private readonly recordTtlMs: number;
  private readonly windowSize: number;
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(options: ProviderHealthTrackerOptions = {}) {
    this.degradeThreshold = Math.max(1, options.degradeThreshold ?? 2);
    this.openThreshold = Math.max(this.degradeThreshold, options.openThreshold ?? 3);
    this.openDurationMs = Math.max(1, options.openDurationMs ?? 30_000);
    this.maxOpenDurationMs = Math.max(this.openDurationMs, options.maxOpenDurationMs ?? 300_000);
    this.recordTtlMs = Math.max(this.openDurationMs, options.recordTtlMs ?? 15 * 60_000);
    this.windowSize = Math.max(1, options.windowSize ?? 20);
    this.capacity = Math.max(1, options.capacity ?? 128);
    this.now = options.now ?? Date.now;
  }

  private prune(now = this.now()): void {
    for (const [id, record] of this.records) {
      if (!record.halfOpenProbeInFlight && now - record.lastTouchedAt >= this.recordTtlMs) this.records.delete(id);
    }
    while (this.records.size >= this.capacity) {
      let oldest: [string, ProviderRecord] | undefined;
      for (const entry of this.records) {
        if (entry[1].halfOpenProbeInFlight) continue;
        if (!oldest || entry[1].lastTouchedAt < oldest[1].lastTouchedAt) oldest = entry;
      }
      if (!oldest) break;
      this.records.delete(oldest[0]);
    }
  }

  private getOrCreate(id: string): ProviderRecord {
    const now = this.now();
    let record = this.records.get(id);
    if (record && !record.halfOpenProbeInFlight && now - record.lastTouchedAt >= this.recordTtlMs) {
      this.records.delete(id);
      record = undefined;
    }
    if (!record) {
      this.prune(now);
      record = {
        state: "healthy", consecutiveFailures: 0, openedAt: 0, cooldownUntil: 0,
        lastTouchedAt: now, halfOpenProbeInFlight: false, openCount: 0, window: [],
      };
      this.records.set(id, record);
    }
    record.lastTouchedAt = now;
    return record;
  }

  private refresh(record: ProviderRecord): void {
    const now = this.now();
    record.lastTouchedAt = now;
    if (record.state === "open" && now >= record.cooldownUntil) record.state = "half_open";
  }

  recordSuccess(id: string, latencyMs?: number): void {
    const record = this.getOrCreate(id);
    record.consecutiveFailures = 0;
    record.window.push(true);
    if (record.window.length > this.windowSize) record.window.shift();
    this.observeLatency(record, latencyMs);
    record.state = "healthy";
    record.openCount = 0;
    record.halfOpenProbeInFlight = false;
  }

  recordFailure(id: string, retryAfterMs?: number, latencyMs?: number): void {
    const record = this.getOrCreate(id);
    record.consecutiveFailures++;
    record.window.push(false);
    if (record.window.length > this.windowSize) record.window.shift();
    this.observeLatency(record, latencyMs);
    if (record.state === "half_open" || record.consecutiveFailures >= this.openThreshold) {
      record.openCount++;
      const exponential = this.openDurationMs * 2 ** Math.min(8, record.openCount - 1);
      const cooldown = Math.min(this.maxOpenDurationMs, Math.max(exponential, retryAfterMs ?? 0));
      record.state = "open";
      record.openedAt = this.now();
      record.cooldownUntil = record.openedAt + cooldown;
      record.halfOpenProbeInFlight = false;
    } else if (record.consecutiveFailures >= this.degradeThreshold) {
      record.state = "degraded";
    }
  }

  private observeLatency(record: ProviderRecord, latencyMs?: number): void {
    if (latencyMs == null || !Number.isFinite(latencyMs) || latencyMs < 0) return;
    record.latencyEwmaMs = record.latencyEwmaMs == null ? latencyMs : record.latencyEwmaMs * 0.8 + latencyMs * 0.2;
  }

  getState(id: string): ProviderHealthState {
    const record = this.records.get(id);
    if (!record) return "healthy";
    if (!record.halfOpenProbeInFlight && this.now() - record.lastTouchedAt >= this.recordTtlMs) {
      this.records.delete(id);
      return "healthy";
    }
    this.refresh(record);
    return record.state;
  }

  /** Atomically reserves the sole half-open probe. */
  tryAcquire(id: string): boolean {
    const record = this.getOrCreate(id);
    this.refresh(record);
    if (record.state === "open") return false;
    if (record.state === "half_open") {
      if (record.halfOpenProbeInFlight) return false;
      record.halfOpenProbeInFlight = true;
    }
    return true;
  }

  release(id: string): void {
    const record = this.records.get(id);
    if (record) record.halfOpenProbeInFlight = false;
  }

  shouldSkip(id: string): boolean {
    const state = this.getState(id);
    const record = this.records.get(id);
    return state === "open" || (state === "half_open" && record?.halfOpenProbeInFlight === true);
  }

  isAvailable(id: string): boolean { return !this.shouldSkip(id); }

  getSuccessRate(id: string): number {
    const window = this.records.get(id)?.window ?? [];
    return (window.filter(Boolean).length + 2) / (window.length + 4);
  }

  getLatencyEwmaMs(id: string): number | undefined { return this.records.get(id)?.latencyEwmaMs; }

  getCooldownRemainingMs(id: string): number {
    if (this.getState(id) !== "open") return 0;
    const record = this.records.get(id);
    return record ? Math.max(0, record.cooldownUntil - this.now()) : 0;
  }

  reset(id: string): void { this.records.delete(id); }
  resetAll(): void { this.records.clear(); }

  snapshot(): Map<string, {
    state: ProviderHealthState;
    successRate: number;
    consecutiveFailures: number;
    latencyEwmaMs?: number;
    cooldownRemainingMs: number;
  }> {
    const result = new Map<string, {
      state: ProviderHealthState; successRate: number; consecutiveFailures: number;
      latencyEwmaMs?: number; cooldownRemainingMs: number;
    }>();
    for (const [id, record] of this.records) {
      result.set(id, {
        state: this.getState(id), successRate: this.getSuccessRate(id),
        consecutiveFailures: record.consecutiveFailures, latencyEwmaMs: record.latencyEwmaMs,
        cooldownRemainingMs: this.getCooldownRemainingMs(id),
      });
    }
    return result;
  }
}
