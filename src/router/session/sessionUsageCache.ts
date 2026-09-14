import type { CanonicalUsage } from "../../model/index.js";

type UsageCacheEntry = {
  usage: CanonicalUsage;
  /** Ms epoch of the observation; missing → staleness unknown. */
  observedAt?: number;
};

export type SessionUsageObserveMeta = {
  provider?: string;
  model?: string;
  observedAt?: number;
};

/**
 * LRU of the most recent canonical usage per session, optionally keyed by
 * (session, provider, model). Model-keyed entries live in separate slots from
 * the legacy session-level key: observing one never populates the other.
 */
export class SessionUsageCache {
  private readonly map = new Map<string, UsageCacheEntry>();
  private readonly capacity: number;

  constructor(capacity = 500) {
    this.capacity = Math.max(1, capacity);
  }

  get(sessionId: string, provider?: string, model?: string): CanonicalUsage | undefined {
    return this.getEntry(sessionId, provider, model)?.usage;
  }

  /** Returns the stored usage plus when it was observed, when present. */
  getEntry(
    sessionId: string,
    provider?: string,
    model?: string,
  ): { usage: CanonicalUsage; observedAt?: number } | undefined {
    return this.map.get(cacheKey(sessionId, provider, model));
  }

  observe(sessionId: string, usage: CanonicalUsage | undefined, meta?: SessionUsageObserveMeta): void {
    if (!usage || !hasUsageSignal(usage)) {
      return;
    }
    const key = cacheKey(sessionId, meta?.provider, meta?.model);
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    this.map.set(key, { usage, observedAt: meta?.observedAt });
  }

  clear(): void {
    this.map.clear();
  }
}

function cacheKey(sessionId: string, provider?: string, model?: string): string {
  return provider !== undefined && model !== undefined
    ? `${sessionId}|${provider}/${model}`
    : sessionId;
}

/** Usage with all-zero/undefined fields carries no evidence and is ignored. */
function hasUsageSignal(usage: CanonicalUsage): boolean {
  for (const value of [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.totalTokens,
    usage.nativeCost,
  ]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return true;
    }
  }
  return false;
}
