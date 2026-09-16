export type ProviderHealthState = "healthy" | "degraded" | "open" | "half_open";

const DEFAULT_DEGRADE_THRESHOLD = 3;
const DEFAULT_OPEN_THRESHOLD = 5;
const DEFAULT_OPEN_DURATION_MS = 30_000;
const DEFAULT_WINDOW_SIZE = 20;

type ProviderRecord = {
  state: ProviderHealthState;
  consecutiveFailures: number;
  /** Timestamp (ms) when the circuit was opened. */
  openedAt: number;
  /** Sliding window of recent results (true = success). */
  window: boolean[];
};

/**
 * Lightweight circuit-breaker that tracks per-provider health.
 *
 * Three+ states:
 *   healthy  → degraded (after `degradeThreshold` consecutive failures)
 *   degraded → open     (after `openThreshold` consecutive failures)
 *   open     → half_open (after `openDurationMs` has elapsed)
 *   half_open → healthy  (probe succeeds) or open (probe fails)
 *
 * The tracker never blocks requests for explicitly-chosen providers
 * (the caller is responsible for that check).
 */
export class ProviderHealthTracker {
  private readonly records = new Map<string, ProviderRecord>();
  private readonly degradeThreshold: number;
  private readonly openThreshold: number;
  private readonly openDurationMs: number;
  private readonly windowSize: number;

  constructor(options?: {
    degradeThreshold?: number;
    openThreshold?: number;
    openDurationMs?: number;
    windowSize?: number;
  }) {
    this.degradeThreshold = options?.degradeThreshold ?? DEFAULT_DEGRADE_THRESHOLD;
    this.openThreshold = options?.openThreshold ?? DEFAULT_OPEN_THRESHOLD;
    this.openDurationMs = options?.openDurationMs ?? DEFAULT_OPEN_DURATION_MS;
    this.windowSize = options?.windowSize ?? DEFAULT_WINDOW_SIZE;
  }

  private getOrCreate(providerId: string): ProviderRecord {
    let rec = this.records.get(providerId);
    if (!rec) {
      rec = { state: "healthy", consecutiveFailures: 0, openedAt: 0, window: [] };
      this.records.set(providerId, rec);
    }
    return rec;
  }

  recordSuccess(providerId: string): void {
    const rec = this.getOrCreate(providerId);
    rec.consecutiveFailures = 0;
    rec.window.push(true);
    if (rec.window.length > this.windowSize) rec.window.shift();
    if (rec.state === "half_open" || rec.state === "degraded" || rec.state === "open") {
      rec.state = "healthy";
      // Clear the stale open-circuit timestamp so a future `getState` cannot
      // accidentally auto-promote a now-healthy provider back to `half_open`
      // on its very next probe. Without this, an `open → healthy` transition
      // via `recordSuccess` would leave `openedAt` set, and any later
      // `recordFailure` followed by `getState` would see "openDurationMs
      // elapsed" using the stale baseline. `half_open → healthy` (the
      // canonical path) does not have this issue because `getState` is what
      // promoted the state in the first place; the defensive reset is cheap
      // and makes the invariant explicit.
      rec.openedAt = 0;
    }
  }

  recordFailure(providerId: string): void {
    const rec = this.getOrCreate(providerId);
    rec.consecutiveFailures++;
    rec.window.push(false);
    if (rec.window.length > this.windowSize) rec.window.shift();
    if (rec.consecutiveFailures >= this.openThreshold) {
      // Refresh `openedAt` whenever consecutive failures re-cross (or
      // remain past) the open threshold. Under the canonical call path the
      // provider is already `open`, so the inner check was previously a
      // no-op — leaving `openedAt` stale from the prior open cycle. A buggy
      // caller that invokes `recordFailure` while the circuit is still
      // `open` (e.g. forgotten `shouldSkip` check) would otherwise be
      // promoted straight back to `half_open` on the next `getState`, even
      // though we just observed another failure.
      const wasOpen = rec.state === "open";
      if (!wasOpen) {
        rec.state = "open";
      }
      rec.openedAt = Date.now();
    } else if (rec.consecutiveFailures >= this.degradeThreshold) {
      if (rec.state === "healthy") {
        rec.state = "degraded";
      }
    }
    if (rec.state === "half_open") {
      rec.state = "open";
      rec.openedAt = Date.now();
    }
  }

  getState(providerId: string): ProviderHealthState {
    const rec = this.records.get(providerId);
    if (!rec) return "healthy";
    if (rec.state === "open" && Date.now() - rec.openedAt >= this.openDurationMs) {
      rec.state = "half_open";
    }
    return rec.state;
  }

  /**
   * Returns true when the provider should be skipped (circuit is open).
   * `half_open` allows one probe request through.
   */
  shouldSkip(providerId: string): boolean {
    return this.getState(providerId) === "open";
  }

  /**
   * Returns true when the provider is in a healthy or half_open (probing) state
   * and can accept requests.
   */
  isAvailable(providerId: string): boolean {
    const state = this.getState(providerId);
    return state !== "open";
  }

  getSuccessRate(providerId: string): number {
    const rec = this.records.get(providerId);
    if (!rec || rec.window.length === 0) return 1;
    return rec.window.filter(Boolean).length / rec.window.length;
  }

  reset(providerId: string): void {
    this.records.delete(providerId);
  }

  resetAll(): void {
    this.records.clear();
  }

  snapshot(): Map<string, { state: ProviderHealthState; successRate: number; consecutiveFailures: number }> {
    const result = new Map<string, { state: ProviderHealthState; successRate: number; consecutiveFailures: number }>();
    for (const [id, rec] of this.records) {
      result.set(id, {
        state: this.getState(id),
        successRate: this.getSuccessRate(id),
        consecutiveFailures: rec.consecutiveFailures,
      });
    }
    return result;
  }
}
