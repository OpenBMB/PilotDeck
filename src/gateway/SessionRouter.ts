import type { AgentSession } from "../agent/index.js";
import type { CanonicalMessage } from "../model/index.js";
import type { AgentCancelSteerResult, AgentSteerResult } from "../agent/session/SteerMailbox.js";
import type { GatewaySessionInfo, ListSessionsInput, ListSessionsResult } from "./protocol/types.js";

export type GatewaySessionContext = {
  sessionKey: string;
  projectKey?: string;
  channelKey: string;
  allowedTools?: string[];
  disallowedTools?: string[];
};

export type GatewaySessionFactory = (context: GatewaySessionContext) => AgentSession | Promise<AgentSession>;
export type GatewaySessionRecreator = (
  context: GatewaySessionContext,
  previousSession: AgentSession,
) => AgentSession | Promise<AgentSession>;

export type SessionRouterOptions = {
  createSession: GatewaySessionFactory;
  recreateSession?: GatewaySessionRecreator;
  listSessions?: (input: ListSessionsInput) => Promise<ListSessionsResult>;
  idleSessionTimeoutMs?: number;
  idleSweepIntervalMs?: number;
  now?: () => Date;
  /**
   * Called (fire-and-forget) when a session is evicted from the router —
   * idle sweep, explicit close, or dirty-recreate. Use this to clean up
   * per-session resources (e.g. per-session MCP runtimes / browser processes).
   */
  onSessionEvict?: (
    sessionKey: string,
    reason: "idle" | "closed" | "dirty_recreate" | "shutdown",
  ) => void;
  onSessionIdleEvict?: (sessionKey: string, record: SessionEvictionSnapshot) => void;
};

type SessionRecord = {
  session: AgentSession;
  lastUsedAt: number;
  context: GatewaySessionContext;
  dirtyReason?: string;
};

export type SessionEvictionSnapshot = {
  sessionKey: string;
  lastUsedAt: number;
  context: GatewaySessionContext;
  messageCount?: number;
};

const DEFAULT_IDLE_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

export class SessionRouter {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly closingSessions = new Map<string, Promise<void>>();
  private readonly closingProjects = new Map<string, string | undefined>();
  private readonly projectGenerations = new Map<string, number>();
  private readonly pausedProjects = new Set<string>();
  private readonly creatingSessions = new Map<Promise<AgentSession>, GatewaySessionContext>();
  private readonly inFlightTurns = new Map<string, string>();
  private readonly sessionControls = new Set<string>();
  private readonly idleSessionTimeoutMs: number;
  private readonly idleSweepIntervalMs: number;
  private readonly now: () => Date;
  private readonly idleSweepTimer?: ReturnType<typeof setInterval>;
  private isShutdown = false;

  constructor(private readonly options: SessionRouterOptions) {
    this.idleSessionTimeoutMs = options.idleSessionTimeoutMs ?? DEFAULT_IDLE_SESSION_TIMEOUT_MS;
    this.idleSweepIntervalMs = options.idleSweepIntervalMs ?? DEFAULT_IDLE_SWEEP_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    if (this.idleSweepIntervalMs > 0) {
      this.idleSweepTimer = setInterval(() => this.sweepIdle(), this.idleSweepIntervalMs);
      this.idleSweepTimer.unref?.();
    }
  }

  async getOrCreate(context: GatewaySessionContext): Promise<AgentSession> {
    this.assertProjectOpen(context.projectKey);
    const generation = this.projectGenerations.get(context.projectKey ?? "");
    this.sweepIdle();
    const closing = this.closingSessions.get(context.sessionKey);
    if (closing) await closing;
    const cached = this.sessions.get(context.sessionKey);
    if (cached) {
      // Tool filters shape the registry constructed for an AgentSession.
      // Recreate only when an explicit Gateway/SDK filter changes; callers
      // without filters retain the exact native cached-session behavior.
      if (hasToolFilterChanged(cached.context, context)) {
        cached.dirtyReason = "tool_filter_changed";
      }
      cached.context = mergeSessionContext(cached.context, context);
      if (cached.dirtyReason && this.options.recreateSession) {
        await this.emitSessionEvict(context.sessionKey, cached, "dirty_recreate");
        const recreated = await this.createTrackedSession(cached.context, () => this.options.recreateSession!(cached.context, cached.session));
        if (generation !== this.projectGenerations.get(context.projectKey ?? "")) {
          await recreated.dispose?.();
          throw new Error("Project was closed while recreating the session.");
        }
        cached.session = recreated;
        cached.dirtyReason = undefined;
      }
      cached.lastUsedAt = this.nowMs();
      return cached.session;
    }

    const session = await this.createTrackedSession(context, () => this.options.createSession(context));
    if (generation !== this.projectGenerations.get(context.projectKey ?? "")) {
      await session.dispose?.();
      throw new Error("Project was closed while creating the session.");
    }
    this.sessions.set(context.sessionKey, {
      session,
      lastUsedAt: this.nowMs(),
      context,
    });
    return session;
  }

  private assertProjectOpen(projectKey?: string): void {
    if (projectKey && this.pausedProjects.has(projectKey)) throw new Error("Project is being deleted.");
  }

  private async createTrackedSession(context: GatewaySessionContext, create: () => AgentSession | Promise<AgentSession>): Promise<AgentSession> {
    this.assertProjectOpen(context.projectKey);
    const pending = Promise.resolve(create());
    this.creatingSessions.set(pending, context);
    try {
      const session = await pending;
      if (context.projectKey && this.pausedProjects.has(context.projectKey)) {
        await session.dispose?.();
        throw new Error("Project is being deleted.");
      }
      return session;
    } finally { this.creatingSessions.delete(pending); }
  }

  /** Pause creation and drain only this project's runtime writers; no history scan. */
  async closeProject(projectKey: string): Promise<string[]> {
    this.pausedProjects.add(projectKey);
    this.projectGenerations.set(projectKey, (this.projectGenerations.get(projectKey) ?? 0) + 1);
    const keys = [...this.sessions].filter(([, record]) => record.context.projectKey === projectKey).map(([key]) => key);
    const creating = [...this.creatingSessions].filter(([, context]) => context.projectKey === projectKey).map(([pending]) => pending);
    const draining = [...this.closingSessions].filter(([key]) => this.closingProjects.get(key) === projectKey).map(([, pending]) => pending);
    await Promise.all([
      ...keys.map(key => this.close(key)),
      ...draining,
      ...creating.map(async pending => { const session = await pending.catch(() => null); await session?.dispose?.(); }),
    ]);
    return keys;
  }

  resumeProject(projectKey: string): void { this.pausedProjects.delete(projectKey); }

  beginTurn(sessionKey: string, runId: string): boolean {
    this.sweepIdle();
    if (this.inFlightTurns.has(sessionKey) || this.sessionControls.has(sessionKey)) {
      return false;
    }
    this.inFlightTurns.set(sessionKey, runId);
    return true;
  }

  hasActiveTurn(sessionKey: string): boolean {
    return this.inFlightTurns.has(sessionKey);
  }

  /** True when a live AgentSession currently owns this key in Gateway memory. */
  hasSession(sessionKey: string): boolean {
    this.sweepIdle();
    return this.sessions.has(sessionKey);
  }

  activeTurnRunId(sessionKey: string): string | undefined {
    return this.inFlightTurns.get(sessionKey);
  }

  endTurn(sessionKey: string, runId?: string): void {
    const record = this.sessions.get(sessionKey);
    const inFlightRunId = this.inFlightTurns.get(sessionKey);
    if (!runId || inFlightRunId === runId) {
      this.inFlightTurns.delete(sessionKey);
    }
    if (record) {
      record.lastUsedAt = this.nowMs();
    }
  }

  async abort(sessionKey: string, reason?: string): Promise<void> {
    const record = this.sessions.get(sessionKey);
    record?.session.abort(reason);
    if (record) {
      record.lastUsedAt = this.nowMs();
    }
  }

  async seedReadState(
    context: GatewaySessionContext,
    input: { path: string; mtime: number },
  ): Promise<{ applied: boolean }> {
    this.sweepIdle();
    if (this.inFlightTurns.has(context.sessionKey) || this.sessionControls.has(context.sessionKey)) {
      throw sessionBusyError("Cannot seed file read state while a turn or session control is active.");
    }

    this.sessionControls.add(context.sessionKey);
    try {
      const session = await this.getOrCreate(context);
      if (this.inFlightTurns.has(context.sessionKey)) {
        throw sessionBusyError("Cannot seed file read state while a turn is active.");
      }
      return await session.seedReadState(input.path, input.mtime);
    } finally {
      this.sessionControls.delete(context.sessionKey);
    }
  }

  steer(
    sessionKey: string,
    input: { turnId: string; itemId: string; message: CanonicalMessage; allowedReadFiles?: string[] },
  ): AgentSteerResult {
    const record = this.sessions.get(sessionKey);
    if (!record) return { accepted: false, reason: "no_active_turn" };
    record.lastUsedAt = this.nowMs();
    return record.session.steer(input);
  }

  cancelSteer(
    sessionKey: string,
    input: { turnId: string; itemId: string },
  ): AgentCancelSteerResult {
    const record = this.sessions.get(sessionKey);
    if (!record) return { cancelled: false, reason: "no_active_turn" };
    record.lastUsedAt = this.nowMs();
    return record.session.cancelSteer(input);
  }

  async close(sessionKey: string): Promise<void> {
    const record = this.sessions.get(sessionKey);
    if (record && this.sessions.delete(sessionKey)) {
      await this.emitSessionEvict(sessionKey, record, "closed");
    } else {
      // An idle eviction or another close may already be draining this writer.
      await this.closingSessions.get(sessionKey);
    }
  }

  markAllDirty(reason = "runtime_changed"): number {
    let count = 0;
    for (const record of this.sessions.values()) {
      record.dirtyReason = reason;
      count += 1;
    }
    return count;
  }

  markProjectDirty(projectKey: string, reason = "runtime_changed"): number {
    let count = 0;
    for (const record of this.sessions.values()) {
      if (record.context.projectKey !== projectKey) {
        continue;
      }
      record.dirtyReason = reason;
      count += 1;
    }
    return count;
  }

  async list(input: ListSessionsInput = {}): Promise<ListSessionsResult> {
    if (this.options.listSessions) {
      return this.options.listSessions(input);
    }

    return {
      sessions: [...this.sessions.entries()].map(([sessionKey, record]): GatewaySessionInfo => {
        const snapshot = record.session.snapshot();
        return {
          sessionId: snapshot.sessionId,
          sessionKey,
          summary: snapshot.messages
            .flatMap((message) => message.content)
            .find((block) => block.type === "text")
            ?.text ?? sessionKey,
          lastModified: record.lastUsedAt,
        };
      }),
    };
  }

  sessionCount(): number {
    this.sweepIdle();
    return this.sessions.size;
  }

  cachedSessionCount(): number {
    return this.sessions.size;
  }

  snapshotSession(sessionKey: string): ReturnType<AgentSession["snapshot"]> | undefined {
    return this.sessions.get(sessionKey)?.session.snapshot();
  }

  shutdown(): void {
    if (this.isShutdown) return;
    this.isShutdown = true;
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
    }
    for (const [sessionKey, record] of this.sessions) {
      void this.emitSessionEvict(sessionKey, record, "shutdown").catch(() => undefined);
    }
    this.sessions.clear();
    this.inFlightTurns.clear();
    this.sessionControls.clear();
  }

  /**
   * Returns true when at least one *user* turn (not always-on / cron) is
   * in flight for the given project.  Used by the Always-On scheduler to
   * implement the `agent_busy` gate.
   */
  hasActiveUserTurn(projectKey: string): boolean {
    for (const [sessionKey] of this.inFlightTurns) {
      if (sessionKey.startsWith("always-on/")) continue;
      if (sessionKey.startsWith("cron:")) continue;
      const record = this.sessions.get(sessionKey);
      if (record?.context.projectKey === projectKey) return true;
    }
    return false;
  }

  private sweepIdle(): void {
    if (this.isShutdown) return;
    const now = this.nowMs();
    for (const [sessionKey, record] of this.sessions) {
      if (this.inFlightTurns.has(sessionKey)) {
        continue;
      }
      if (now - record.lastUsedAt > this.idleSessionTimeoutMs) {
        this.sessions.delete(sessionKey);
        void this.emitSessionEvict(sessionKey, record, "idle").catch(() => undefined);
      }
    }
  }

  private emitSessionEvict(
    sessionKey: string,
    record: SessionRecord,
    reason: "idle" | "closed" | "dirty_recreate" | "shutdown",
  ): Promise<void> {
    const disposed = (record.session.dispose?.() ?? Promise.resolve()).finally(() => {
      if (this.closingSessions.get(sessionKey) === disposed) {
        this.closingSessions.delete(sessionKey);
        this.closingProjects.delete(sessionKey);
      }
    });
    this.closingSessions.set(sessionKey, disposed);
    this.closingProjects.set(sessionKey, record.context.projectKey);
    this.options.onSessionEvict?.(sessionKey, reason);
    if (reason === "idle") {
      this.options.onSessionIdleEvict?.(sessionKey, snapshotEvictedSession(sessionKey, record));
    }
    return disposed;
  }

  private nowMs(): number {
    return this.now().getTime();
  }
}

function snapshotEvictedSession(sessionKey: string, record: SessionRecord): SessionEvictionSnapshot {
  let messageCount: number | undefined;
  try {
    messageCount = record.session.snapshot().messages.length;
  } catch {
    messageCount = undefined;
  }
  return {
    sessionKey,
    lastUsedAt: record.lastUsedAt,
    context: { ...record.context },
    ...(messageCount !== undefined ? { messageCount } : {}),
  };
}

function mergeSessionContext(
  current: GatewaySessionContext,
  next: GatewaySessionContext,
): GatewaySessionContext {
  return {
    sessionKey: next.sessionKey,
    channelKey: next.channelKey || current.channelKey,
    projectKey: current.projectKey ?? next.projectKey,
    allowedTools: next.allowedTools ?? current.allowedTools,
    disallowedTools: next.disallowedTools ?? current.disallowedTools,
  };
}

function hasToolFilterChanged(
  current: GatewaySessionContext,
  next: GatewaySessionContext,
): boolean {
  // `undefined` means that this turn does not update the session's tool
  // filter. The Gateway wire format deliberately has no implicit "clear"
  // operation, so an ordinary native turn cannot undo an SDK-set filter.
  return (next.allowedTools !== undefined
      && !sameOptionalStringArray(current.allowedTools, next.allowedTools))
    || (next.disallowedTools !== undefined
      && !sameOptionalStringArray(current.disallowedTools, next.disallowedTools));
}

function sameOptionalStringArray(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sessionBusyError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "SESSION_BUSY" });
}
