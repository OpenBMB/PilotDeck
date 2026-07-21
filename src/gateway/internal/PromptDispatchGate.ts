import { randomUUID } from "node:crypto";
import type { GatewayChannelKey } from "../protocol/types.js";

export type InternalPromptRequest = {
  sessionKey: string;
  prompt: string;
  source: string;
  dedupeKey: string;
  target?: { channelKey: GatewayChannelKey; projectKey?: string };
  queueBehavior?: "enqueue" | "defer";
  settleMs?: number;
  waitTimeoutMs?: number;
  turnTimeoutMs?: number;
  recentDedupeMs?: number;
  signal?: AbortSignal;
};

export type InternalPromptResult =
  | { status: "completed"; dispatchId: string; runId: string; finishReason: string; coalesced?: boolean }
  | { status: "deduped"; dispatchId: string }
  | { status: "deferred"; reason: "busy" }
  | { status: "aborted"; phase: "queued" | "waiting_idle" | "running" }
  | { status: "timed_out"; phase: "waiting_idle" | "running" }
  | { status: "failed"; phase: "dispatch" | "running"; error: unknown };

export type InternalTurnResult =
  | { status: "completed"; runId: string; finishReason: string }
  | { status: "busy" }
  | { status: "timed_out" }
  | { status: "failed"; error: unknown };

export type PromptDispatchHost = {
  isSessionBusy(sessionKey: string): boolean;
  waitForSessionIdle(sessionKey: string, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  runInternalTurn(input: {
    sessionKey: string;
    prompt: string;
    source: string;
    runId: string;
    channelKey: GatewayChannelKey;
    projectKey?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<InternalTurnResult>;
};

export class PromptDispatchGate {
  private readonly pending = new Map<string, Promise<InternalPromptResult>>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly recent = new Map<string, { dispatchId: string; expiresAt: number }>();
  private disposed = false;

  constructor(
    private readonly host: PromptDispatchHost,
    private readonly options: { now?: () => number; uuid?: () => string } = {},
  ) {}

  dispatch(request: InternalPromptRequest): Promise<InternalPromptResult> {
    if (this.disposed) return Promise.resolve({ status: "failed", phase: "dispatch", error: new Error("Prompt dispatch gate is disposed.") });
    if (request.signal?.aborted) return Promise.resolve({ status: "aborted", phase: "queued" });
    if (request.queueBehavior === "defer" && this.host.isSessionBusy(request.sessionKey)) {
      return Promise.resolve({ status: "deferred", reason: "busy" });
    }

    const key = `${request.sessionKey}\0${request.dedupeKey}`;
    const now = this.now();
    this.pruneRecent(now);
    const recent = this.recent.get(key);
    const recentWindow = Math.max(0, request.recentDedupeMs ?? 30_000);
    if (recent && now <= recent.expiresAt) {
      return Promise.resolve({ status: "deduped", dispatchId: recent.dispatchId });
    }
    const existing = this.pending.get(key);
    if (existing) {
      return existing.then((result) => result.status === "completed" ? { ...result, coalesced: true } : result);
    }

    const previous = this.tails.get(request.sessionKey) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.execute(request, key));
    this.pending.set(key, operation);
    const tail = operation.then(() => undefined, () => undefined);
    this.tails.set(request.sessionKey, tail);
    const cleanup = () => {
      if (this.pending.get(key) === operation) this.pending.delete(key);
      if (this.tails.get(request.sessionKey) === tail) this.tails.delete(request.sessionKey);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  dispose(): void {
    this.disposed = true;
    this.recent.clear();
  }

  private async execute(request: InternalPromptRequest, key: string): Promise<InternalPromptResult> {
    const dispatchId = this.uuid();
    const startedAt = this.now();
    const recentWindow = Math.max(0, request.recentDedupeMs ?? 30_000);
    const remainingWait = () => request.waitTimeoutMs === undefined
      ? undefined
      : Math.max(0, request.waitTimeoutMs - (this.now() - startedAt));

    while (true) {
      if (this.disposed) return this.disposedResult();
      if (request.signal?.aborted) return { status: "aborted", phase: "waiting_idle" };
      if (this.host.isSessionBusy(request.sessionKey)) {
        if (request.queueBehavior === "defer") return { status: "deferred", reason: "busy" };
        const timeoutMs = remainingWait();
        if (timeoutMs === 0) return { status: "timed_out", phase: "waiting_idle" };
        try {
          await this.host.waitForSessionIdle(request.sessionKey, { signal: request.signal, timeoutMs });
        } catch (error) {
          if (request.signal?.aborted || isAbortError(error)) return { status: "aborted", phase: "waiting_idle" };
          return { status: "timed_out", phase: "waiting_idle" };
        }
      }

      if (this.disposed) return this.disposedResult();

      if ((request.settleMs ?? 0) > 0) {
        try {
          await delay(request.settleMs!, request.signal);
        } catch {
          return { status: "aborted", phase: "waiting_idle" };
        }
      }

      if (this.disposed) return this.disposedResult();

      const runId = this.uuid();
      let result: InternalTurnResult;
      try {
        result = await this.host.runInternalTurn({
          sessionKey: request.sessionKey,
          prompt: request.prompt,
          source: request.source,
          runId,
          channelKey: request.target?.channelKey ?? "internal",
          projectKey: request.target?.projectKey,
          timeoutMs: request.turnTimeoutMs,
          signal: request.signal,
        });
      } catch (error) {
        return request.signal?.aborted
          ? { status: "aborted", phase: "running" }
          : { status: "failed", phase: "dispatch", error };
      }
      if (result.status === "busy") continue;
      if (result.status === "timed_out") return { status: "timed_out", phase: "running" };
      if (result.status === "failed") {
        return request.signal?.aborted
          ? { status: "aborted", phase: "running" }
          : { status: "failed", phase: "running", error: result.error };
      }

      if (recentWindow > 0) {
        this.recent.set(key, { dispatchId, expiresAt: this.now() + recentWindow });
        this.pruneRecent(this.now());
      }
      return { status: "completed", dispatchId, runId: result.runId, finishReason: result.finishReason };
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private uuid(): string {
    return this.options.uuid?.() ?? randomUUID();
  }

  private pruneRecent(now: number): void {
    for (const [key, entry] of this.recent) {
      if (entry.expiresAt < now) this.recent.delete(key);
    }
    while (this.recent.size > 4_096) {
      const oldest = this.recent.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.recent.delete(oldest);
    }
  }

  private disposedResult(): InternalPromptResult {
    return { status: "failed", phase: "dispatch", error: new Error("Prompt dispatch gate is disposed.") };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
