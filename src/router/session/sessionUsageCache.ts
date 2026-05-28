import type { CanonicalUsage } from "../../model/index.js";

export class SessionUsageCache {
  private readonly map = new Map<string, CanonicalUsage>();
  private readonly capacity: number;

  constructor(capacity = 500) {
    this.capacity = Math.max(1, capacity);
  }

  get(sessionId: string): CanonicalUsage | undefined {
    return this.map.get(sessionId);
  }

  observe(sessionId: string, usage: CanonicalUsage | undefined): void {
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
    this.map.set(sessionId, usage);
  }

  clear(): void {
    this.map.clear();
  }
}
