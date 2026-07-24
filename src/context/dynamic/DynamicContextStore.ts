export type DynamicContextPriority = "critical" | "high" | "normal" | "low";

export type DynamicContextEntry = {
  readonly sessionId: string;
  readonly id: string;
  readonly source: string;
  readonly content: string;
  readonly priority?: DynamicContextPriority;
  readonly turnId?: string;
  readonly expiresAt?: number;
};

export type PendingDynamicContext = {
  readonly entries: readonly DynamicContextEntry[];
  readonly merged: string;
};

const PRIORITY_ORDER: Record<DynamicContextPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const CONTEXT_SEPARATOR = "\n\n---\n\n";
const MAX_ENTRIES_PER_SESSION = 64;
const MAX_ENTRY_CHARS = 16_384;
const MAX_MERGED_CHARS = 65_536;

/** Collects hook-produced context until the next model request consumes it. */
export class DynamicContextStore {
  private readonly sessions = new Map<string, Map<string, DynamicContextEntry>>();
  private readonly registrationOrders = new Map<string, Map<string, number>>();
  private nextRegistrationOrder = 0;

  register(entry: DynamicContextEntry): void {
    const content = entry.content.trim().slice(0, MAX_ENTRY_CHARS);
    if (content.length === 0) return;

    const session = this.sessions.get(entry.sessionId) ?? new Map<string, DynamicContextEntry>();
    const key = entryKey(entry);
    const orders = this.registrationOrders.get(entry.sessionId) ?? new Map<string, number>();
    if (!orders.has(key)) {
      orders.set(key, ++this.nextRegistrationOrder);
    }
    this.registrationOrders.set(entry.sessionId, orders);
    session.set(key, { ...entry, content, priority: entry.priority ?? "normal" });
    this.trimSession(entry.sessionId, session);
    this.sessions.set(entry.sessionId, session);
  }

  getPending(sessionId: string, now = Date.now()): PendingDynamicContext {
    const session = this.sessions.get(sessionId);
    if (!session) return { entries: [], merged: "" };

    this.pruneExpired(sessionId, session, now);
    const sorted = [...session.values()].sort((a, b) => {
      const priority = PRIORITY_ORDER[a.priority ?? "normal"] - PRIORITY_ORDER[b.priority ?? "normal"];
      if (priority !== 0) return priority;
      return this.order(sessionId, a) - this.order(sessionId, b);
    });
    const entries: DynamicContextEntry[] = [];
    let remaining = MAX_MERGED_CHARS;
    for (const entry of sorted) {
      const separatorChars = entries.length === 0 ? 0 : CONTEXT_SEPARATOR.length;
      if (remaining <= separatorChars) break;
      remaining -= separatorChars;
      const content = entry.content.slice(0, remaining);
      if (!content) break;
      entries.push(content === entry.content ? entry : { ...entry, content });
      remaining -= content.length;
    }
    return { entries, merged: entries.map((entry) => entry.content).join(CONTEXT_SEPARATOR) };
  }

  consume(sessionId: string, now = Date.now()): PendingDynamicContext {
    const pending = this.getPending(sessionId, now);
    this.clear(sessionId);
    return pending;
  }

  hasPending(sessionId: string, now = Date.now()): boolean {
    return this.getPending(sessionId, now).entries.length > 0;
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.registrationOrders.delete(sessionId);
  }

  private pruneExpired(
    sessionId: string,
    session: Map<string, DynamicContextEntry>,
    now: number,
  ): void {
    for (const [key, entry] of session) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        session.delete(key);
        this.registrationOrders.get(sessionId)?.delete(key);
      }
    }
    if (session.size === 0) this.clear(sessionId);
  }

  private order(sessionId: string, entry: DynamicContextEntry): number {
    return this.registrationOrders.get(sessionId)?.get(entryKey(entry)) ?? 0;
  }

  private trimSession(sessionId: string, session: Map<string, DynamicContextEntry>): void {
    if (session.size <= MAX_ENTRIES_PER_SESSION) return;
    const worstFirst = [...session.entries()].sort(([, a], [, b]) => {
      const priority = PRIORITY_ORDER[b.priority ?? "normal"] - PRIORITY_ORDER[a.priority ?? "normal"];
      if (priority !== 0) return priority;
      return this.order(sessionId, b) - this.order(sessionId, a);
    });
    for (const [key] of worstFirst.slice(0, session.size - MAX_ENTRIES_PER_SESSION)) {
      session.delete(key);
      this.registrationOrders.get(sessionId)?.delete(key);
    }
  }
}

function entryKey(entry: Pick<DynamicContextEntry, "source" | "id">): string {
  return JSON.stringify([entry.source, entry.id]);
}
