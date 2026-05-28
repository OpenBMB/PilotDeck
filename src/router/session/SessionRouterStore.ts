import type { SessionRoutingState } from "../protocol/decision.js";

export type SessionRouterStoreOptions = {
  capacity?: number;
  ttlMs?: number;
  now?: () => number;
};

const DEFAULT_CAPACITY = 500;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

type Slot = {
  key: string;
  state: SessionRoutingState;
  expiresAt: number;
};

export class SessionRouterStore {
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly map = new Map<string, Slot>();

  constructor(options: SessionRouterStoreOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS);
    this.now = options.now ?? (() => Date.now());
  }

  get(sessionId: string, isSubagent: boolean): SessionRoutingState | undefined {
    const key = makeKey(sessionId, isSubagent);
    const slot = this.map.get(key);
    if (!slot) {
      return undefined;
    }
    if (slot.expiresAt < this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, slot);
    return slot.state;
  }

  set(state: SessionRoutingState): void {
    const key = makeKey(state.sessionId, state.isSubagent);
    const slot: Slot = {
      key,
      state,
      expiresAt: this.now() + this.ttlMs,
    };
    if (this.map.has(key)) {
      this.map.delete(key);
    } else {
      while (this.map.size >= this.capacity) {
        const oldestKey = this.map.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, slot);
  }

  delete(sessionId: string, isSubagent: boolean): void {
    this.map.delete(makeKey(sessionId, isSubagent));
  }

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

function makeKey(sessionId: string, isSubagent: boolean): string {
  return isSubagent ? `${sessionId}:sub` : sessionId;
}
