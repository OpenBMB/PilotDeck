import type { CanonicalUsage } from "../../model/index.js";

type UsageTarget = { provider: string; model: string };

export class SessionUsageCache {
  private readonly map = new Map<string, { usage: CanonicalUsage; target?: UsageTarget }>();
  private readonly capacity: number;

  constructor(capacity = 500) {
    this.capacity = Math.max(1, capacity);
  }

  get(sessionId: string, target?: UsageTarget): CanonicalUsage | undefined {
    const observed = this.map.get(sessionId);
    if (target && observed?.target &&
      (observed.target.provider !== target.provider || observed.target.model !== target.model)) return undefined;
    return observed?.usage;
  }

  observe(sessionId: string, usage: CanonicalUsage | undefined, target?: UsageTarget): void {
    if (!usage) {
      return;
    }
    if (this.map.has(sessionId)) {
      this.map.delete(sessionId);
    } else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    this.map.set(sessionId, { usage, target });
  }

  clear(): void {
    this.map.clear();
  }
}
