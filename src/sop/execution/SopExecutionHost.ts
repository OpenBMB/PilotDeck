import { randomUUID } from "node:crypto";
import type { SopCall, SopExecutionClient, SopJson } from "./SopExecutionClient.js";

export type SopNodeExecutor = (call: SopCall, signal: AbortSignal) => Promise<SopJson>;

/** Owns effects only. Scheduling, leases and state transitions belong to Runtime. */
export class SopExecutionHost {
  private readonly workerId = randomUUID();
  private stopped = false;
  private loop?: Promise<void>;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  constructor(private readonly client: SopExecutionClient, private readonly execute: SopNodeExecutor,
    private readonly diagnostic: (error: unknown) => void = () => {}, private parallelism = 32) {}

  async start(): Promise<void> {
    await this.client.preflight();
    const health = await this.client.request<{ maxConcurrency: number }>("/healthz");
    if (Number.isSafeInteger(health.maxConcurrency) && health.maxConcurrency > 0) this.parallelism = health.maxConcurrency;
    this.loop = this.poll();
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    for (const { controller } of this.active.values()) controller.abort();
    await this.loop;
    await Promise.all([...this.active.values()].map(value => value.promise));
  }

  private async poll(): Promise<void> {
    while (!this.stopped) {
      try {
        if (this.active.size < this.parallelism) {
          const response = await this.client.request<{ calls: SopCall[] }>("/v4/worker/claim", undefined,
            { workerId: this.workerId, limit: this.parallelism - this.active.size });
          for (const call of response.calls) {
            if (this.stopped) break;
            const controller = new AbortController();
            const promise = this.run(call, controller).catch(this.diagnostic).finally(() => this.active.delete(call.id));
            this.active.set(call.id, { controller, promise });
          }
        }
      } catch (error) { this.diagnostic(error); }
      if (!this.stopped) await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  }

  private async run(call: SopCall, controller: AbortController): Promise<void> {
    let heartbeat: Promise<unknown> | undefined;
    const timer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = this.client.request(`/v4/calls/${call.id}/heartbeat`, undefined, { leaseToken: call.lease.token })
        .catch(error => { controller.abort(error); }).finally(() => { heartbeat = undefined; });
    }, 10_000);
    let result: SopJson;
    try {
      result = await this.execute(call, controller.signal);
    } catch (error) {
      result = { status: "result_unknown", error: { code: "SOP_HOST_EXECUTION_UNKNOWN", message: error instanceof Error ? error.message : String(error) } };
    } finally {
      clearInterval(timer);
      await heartbeat;
    }
    // A lost submit response is retried with the exact same request and lease.
    const body = { ...result, requestId: `${call.id}:${call.attempt}:result`, leaseToken: call.lease.token };
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await this.client.request(`/v4/calls/${call.id}/submit`, undefined, body); return; }
      catch (error) {
        if ((error as { code?: string }).code === "SOP_LEASE_STALE") return;
        if (["SOP_V4_INVALID", "SOP_INPUT_MISSING", "SOP_CONCURRENCY_INVALID", "SOP_INVOCATION_LIMIT", "INVALID_TRANSITION", "NEXT_NODE_REQUIRED"].includes((error as { code?: string }).code ?? "")) {
          await this.client.request(`/v4/calls/${call.id}/submit`, undefined, {
            requestId: `${body.requestId}:invalid`, leaseToken: call.lease.token, status: "failed",
            model: result.model, usage: result.usage, error: { code: "SOP_NODE_RESULT_INVALID", message: String(error) },
          });
          return;
        }
        if (attempt === 2) throw error;
      }
    }
  }
}
