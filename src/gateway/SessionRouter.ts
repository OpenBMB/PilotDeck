import type { AgentSession } from "../agent/index.js";
import type { GatewaySessionInfo, ListSessionsInput, ListSessionsResult } from "./protocol/types.js";

export type GatewaySessionContext = {
  sessionKey: string;
  projectKey?: string;
  channelKey: string;
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
  now?: () => Date;
  /**
   * Called (fire-and-forget) when a session is evicted from the router —
   * idle sweep, explicit close, or dirty-recreate. Use this to clean up
   * per-session resources (e.g. per-session MCP runtimes / browser processes).
   */
  onSessionEvict?: (sessionKey: string) => void;
};

type SessionRecord = {
  session: AgentSession;
  lastUsedAt: number;
  context: GatewaySessionContext;
  dirtyReason?: string;
};

const DEFAULT_IDLE_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export class SessionRouter {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly inFlightTurns = new Map<string, string>();
  private readonly idleSessionTimeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: SessionRouterOptions) {
    this.idleSessionTimeoutMs = options.idleSessionTimeoutMs ?? DEFAULT_IDLE_SESSION_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  async getOrCreate(context: GatewaySessionContext): Promise<AgentSession> {
    this.sweepIdle();
    const cached = this.sessions.get(context.sessionKey);
    if (cached) {
      cached.context = mergeSessionContext(cached.context, context);
      if (cached.dirtyReason && this.options.recreateSession) {
        this.options.onSessionEvict?.(context.sessionKey);
        cached.session = await this.options.recreateSession(cached.context, cached.session);
        cached.dirtyReason = undefined;
      }
      cached.lastUsedAt = this.nowMs();
      return cached.session;
    }

    const session = await this.options.createSession(context);
    this.sessions.set(context.sessionKey, {
      session,
      lastUsedAt: this.nowMs(),
      context,
    });
    return session;
  }

  beginTurn(sessionKey: string, runId: string): boolean {
    this.sweepIdle();
    if (this.inFlightTurns.has(sessionKey)) {
      return false;
    }
    this.inFlightTurns.set(sessionKey, runId);
    return true;
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

  async close(sessionKey: string): Promise<void> {
    if (this.sessions.delete(sessionKey)) {
      this.options.onSessionEvict?.(sessionKey);
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
    const now = this.nowMs();
    for (const [sessionKey, record] of this.sessions) {
      if (this.inFlightTurns.has(sessionKey)) {
        continue;
      }
      if (now - record.lastUsedAt > this.idleSessionTimeoutMs) {
        this.sessions.delete(sessionKey);
        this.options.onSessionEvict?.(sessionKey);
      }
    }
  }

  private nowMs(): number {
    return this.now().getTime();
  }
}

function mergeSessionContext(
  current: GatewaySessionContext,
  next: GatewaySessionContext,
): GatewaySessionContext {
  return {
    sessionKey: next.sessionKey,
    channelKey: next.channelKey || current.channelKey,
    projectKey: current.projectKey ?? next.projectKey,
  };
}
