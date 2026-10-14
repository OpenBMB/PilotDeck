import type { StaffDeckSopState, StaffDeckSopRuntimeClient, StaffDeckSopStep } from "./types.js";

export type PortableSopState = {
  session_id: string; sop_id: string; sop_version: string; active_node_id: string | null;
  slots: Record<string, unknown>; pending_wait: Record<string, unknown> | null;
  status: string; revision: number; metadata: Record<string, unknown>;
};

export type PortableSopEnvelope = Readonly<{
  protocolVersion: "3.0";
  requestId: string;
  operationId: string;
  turnId: string;
  expectedRevision?: number;
  idempotencyKey?: string;
}>;

export type PortableSopReceipt = Readonly<{
  capabilityId: string;
  operationId: string;
  nodeId: string;
  sessionId: string;
  turnId: string;
  status: "succeeded" | "failed";
  result?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}>;

export type PortableSopRuntimeClientOptions = Readonly<{
  fetch?: typeof fetch;
  timeoutMs?: number;
  publishToken?: string;
}>;

export class PortableSopRuntimeError extends Error {
  readonly name = "PortableSopRuntimeError";
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

/** Client for the independent stateful SOP Runtime v3. */
export class PortableSopRuntimeClient {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs?: number;
  private readonly publishToken?: string;

  constructor(endpoint: string, options: PortableSopRuntimeClientOptions = {}) {
    this.endpoint = endpoint.replace(/\/+$/u, "");
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs;
    this.publishToken = options.publishToken;
  }

  async publishDefinition(definition: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("/v1/definitions", { method: "POST", body: definition });
  }

  async catalog(): Promise<readonly Record<string, unknown>[]> {
    const result = await this.request("/v1/management/catalog", { method: "GET" });
    if (!Array.isArray(result.definitions)) throw new PortableSopRuntimeError("SOP_RUNTIME_PROTOCOL", "Missing published definitions.");
    return result.definitions as Record<string, unknown>[];
  }

  async prepare(input: PortableSopEnvelope & { sessionId: string; sopId: string; version?: string }): Promise<Record<string, unknown>> {
    return this.request(`/v1/sessions/${encodeURIComponent(input.sessionId)}/prepare`, { method: "POST", body: { ...this.envelope(input), sopId: input.sopId, ...(input.version ? { version: input.version } : {}) } });
  }

  async submit(input: PortableSopEnvelope & { sessionId: string; proposal: Record<string, unknown>; receipts?: readonly PortableSopReceipt[] }): Promise<Record<string, unknown>> {
    return this.request(`/v1/sessions/${encodeURIComponent(input.sessionId)}/submit`, { method: "POST", body: { ...this.envelope(input), proposal: input.proposal, receipts: input.receipts ?? [] } });
  }

  async resume(input: PortableSopEnvelope & { sessionId: string; waitId?: string; slotUpdates?: Record<string, unknown>; response?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    return this.request(`/v1/sessions/${encodeURIComponent(input.sessionId)}/resume`, { method: "POST", body: { ...this.envelope(input), ...(input.waitId ? { waitId: input.waitId } : {}), slotUpdates: input.slotUpdates ?? {}, response: input.response ?? {} } });
  }

  async session(sessionId: string): Promise<{ state: PortableSopState; definition: Record<string, unknown> }> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "GET" }) as Promise<{ state: PortableSopState; definition: Record<string, unknown> }>;
  }

  private envelope(input: PortableSopEnvelope): PortableSopEnvelope {
    return { protocolVersion: "3.0", requestId: input.requestId, operationId: input.operationId, turnId: input.turnId,
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) };
  }

  private async request(path: string, options: { method: "GET" | "POST"; body?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const controller = this.timeoutMs === undefined ? undefined : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
    try {
      const response = await this.fetcher(`${this.endpoint}${path}`, {
        method: options.method,
        headers: { "content-type": "application/json", ...(path === "/v1/definitions" && this.publishToken ? { authorization: `Bearer ${this.publishToken}` } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      });
      const payload = await response.json() as Record<string, unknown>;
      if (options.body?.protocolVersion && (payload.protocolVersion !== "3.0"
        || typeof payload.requestId !== "string" || typeof payload.ok !== "boolean")) {
        throw new PortableSopRuntimeError("SOP_RUNTIME_PROTOCOL", "Invalid lifecycle v3 response envelope.");
      }
      if (!response.ok || payload.ok === false) {
        const error = (payload.error ?? {}) as Record<string, unknown>;
        throw new PortableSopRuntimeError(String(error.code ?? "SOP_RUNTIME_ERROR"), String(error.message ?? `Runtime returned HTTP ${response.status}`), error.details as Record<string, unknown> | undefined);
      }
      return (payload.payload ?? payload) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof PortableSopRuntimeError) throw error;
      throw new PortableSopRuntimeError("SOP_RUNTIME_UNAVAILABLE", error instanceof Error ? error.message : String(error));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** A host projection only: every graph transition is committed by Runtime. */
export function projectRuntimeState(state: PortableSopState): StaffDeckSopState {
  let localId = state.sop_id;
  try {
    const scope = JSON.parse(state.sop_id);
    if (Array.isArray(scope) && scope.length === 4 && scope[0] === "staffdeck" && typeof scope[3] === "string") localId = scope[3];
  } catch { /* Standalone definition IDs are plain strings. */ }
  return { ...state, version: 1, selected_skill_id: localId, active_skill_id: localId,
    active_step_id: state.active_node_id ?? undefined, slots_json: state.slots,
    awaiting_input_json: state.pending_wait, successful_tool_names: [] };
}

export class PortableSopHostClient implements StaffDeckSopRuntimeClient {
  constructor(readonly runtime: PortableSopRuntimeClient, private readonly bindings: readonly { capabilityId: string; toolName: string }[] = [],
    private readonly scope?: Readonly<{ tenantId: string; agentId: string }>) {}

  async prepare(input: Parameters<StaffDeckSopRuntimeClient["prepare"]>[0]) {
    const scope = input.context;
    if (!scope) throw new PortableSopRuntimeError("SOP_SCOPE_REQUIRED", "Runtime requires host session and turn identifiers.");
    const selected = input.state.active_skill_id ?? input.state.selected_skill_id;
    const definition = input.bundle.sops.find(item => (item.id ?? item.skill_id) === selected);
    const sopId = this.scope ? JSON.stringify(["staffdeck", this.scope.tenantId, this.scope.agentId, selected]) : selected!;
    const response = await this.runtime.prepare({ ...scope, protocolVersion: "3.0", sopId,
      version: typeof definition?.version === "string" ? definition.version : undefined });
    const state = response.state as PortableSopState;
    const step = response.step as Record<string, unknown>;
    const requirements = step.capabilityRequirements as Array<{ capability_id: string; required: boolean }>;
    const requiredTools = [...new Set([...(step.requiredCapabilityIds as string[]), ...requirements.filter(item => item.required)
      .map(item => item.capability_id)])].map(id => this.bindings.find(binding => binding.capabilityId === id)?.toolName ?? id);
    return { state: projectRuntimeState(state), step: {
      ...step, skillId: selected, skillName: selected, version: state.sop_version,
      knownSlots: state.slots, allowedNextStepIds: step.allowedNextNodeIds,
      requiredToolNames: [...new Set(requiredTools)],
      transitions: (step.transitions as Array<Record<string, unknown>>).map(edge => ({ ...edge,
        nextStepId: edge.nextNodeId, targetStep: edge.targetNode })),
    } as StaffDeckSopStep };
  }

  async submit(input: Parameters<StaffDeckSopRuntimeClient["submit"]>[0]) {
    const scope = input.context;
    if (!scope) throw new PortableSopRuntimeError("SOP_SCOPE_REQUIRED", "Runtime requires host session and turn identifiers.");
    const response = await this.runtime.submit({ ...scope, protocolVersion: "3.0",
      proposal: input.proposal, receipts: input.receipts ?? [] });
    const state = response.state as PortableSopState;
    const result = response.result as Record<string, unknown>;
    return { state: projectRuntimeState(state), result: { status: state.status, replyFragment: String(result.reply ?? ""),
      slotUpdates: input.proposal.slotUpdates ?? {}, nextStepId: state.active_node_id,
      structuredResult: result.structuredResult, events: [] } };
  }
}
