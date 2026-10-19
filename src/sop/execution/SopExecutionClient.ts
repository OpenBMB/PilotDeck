export type SopJson = Record<string, unknown>;
export type SopCall = {
  id: string; runId: string; executionId: string; nodeId: string; invocation: number; attempt: number;
  scope: string; input: SopJson; history: unknown[]; template?: string;
  node: { instruction?: string; type?: string; tools?: string[] };
  model?: { provider: string; model: string };
  lease: { token: string }; approvalResponse?: string;
  allowedNextNodeIds?: string[];
};

export class SopExecutionClient {
  constructor(readonly endpoint: string, private readonly token: string,
    private readonly validateBindings?: (scope: string, definitions: SopJson[], model?: SopJson) => void | Promise<void>,
    private readonly timeoutMs = 30_000) {}

  async request<T = SopJson>(path: string, scope?: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(new URL(path, this.endpoint), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", ...(scope ? { "x-sop-scope": scope } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
    });
    const value = await response.json() as { error?: { code: string; message: string } };
    if (!response.ok) throw Object.assign(new Error(value.error?.message ?? `SOP HTTP ${response.status}`), { code: value.error?.code ?? "SOP_HTTP_ERROR" });
    return value as T;
  }

  async preflight(): Promise<void> {
    const manifest = await this.request("/healthz");
    if (manifest.contract !== "sop.lifecycle/v4") throw new Error("SOP execution requires sop.lifecycle/v4");
    await this.request("/v4/ready");
  }

  async call(operation: string, scope: string, input: SopJson, signal?: AbortSignal): Promise<SopJson> {
    const fields: Record<string, string[]> = {
      run_sop: ["requestId", "sopId", "version", "input", "items", "concurrency", "model"],
      sop_status: ["runId", "offset", "limit"], sop_result: ["runId", "offset", "limit"],
      sop_events: ["runId", "after"], sop_wait: ["runId", "timeoutMs"],
      sop_cancel: ["runId", "requestId"], sop_retry: ["runId", "requestId", "callIds"],
      sop_resume_execution: ["runId", "requestId", "callId", "waitId", "message", "subjectUserId"],
    };
    if (!fields[operation] || Object.keys(input).some(key => !fields[operation].includes(key))) throw new Error("Unknown SOP execution field or operation");
    for (const key of ["offset", "limit", "after", "timeoutMs"]) {
      if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || Number(input[key]) < (key === "limit" ? 1 : 0))) throw new Error(`Invalid ${key}`);
    }
    const { runId, offset = 0, limit = 100, after = 0, timeoutMs = 30_000, ...body } = input;
    if (operation === "run_sop") {
      await this.preflight();
      const check = await this.request<{ definitions: SopJson[] }>("/v4/preflight", undefined,
        { sopId: body.sopId, version: body.version }, signal);
      await this.validateBindings?.(scope, check.definitions, body.model as SopJson | undefined);
      return this.request("/v4/runs", scope, body, signal);
    }
    if (typeof runId !== "string" || !/^[a-f0-9]{32}$/.test(runId)) throw new Error("A valid runId is required");
    const base = `/v4/runs/${runId}`;
    if (operation === "sop_status") return this.request(`${base}?offset=${Number(offset)}&limit=${Number(limit)}`, scope, undefined, signal);
    if (operation === "sop_result") return this.request(`${base}/results?offset=${Number(offset)}&limit=${Number(limit)}`, scope, undefined, signal);
    if (operation === "sop_events") return this.request(`${base}/events?after=${Number(after)}`, scope, undefined, signal);
    if (operation === "sop_wait") {
      const end = Date.now() + Math.min(60_000, Math.max(0, Number(timeoutMs)));
      for (;;) {
        const result = await this.request(base, scope, undefined, signal);
        if (result.status !== "running" || Date.now() >= end) return result;
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        signal?.throwIfAborted();
      }
    }
    const route = { sop_cancel: "cancel", sop_retry: "retry", sop_resume_execution: "resume" }[operation];
    if (!route) throw new Error("Unknown SOP operation");
    return this.request(`${base}/${route}`, scope, body, signal);
  }
}
