export const MODULE_PROTOCOL_VERSION = "2.0" as const;

export type ModuleOutcome = "completed" | "failed" | "cancelled" | "result_unknown";
export type ModuleExecuteProfile = "unary" | "streaming" | "side_effect" | "tool";
export type ModuleRetryability = "safe" | "unsafe" | "retry_after_status";
export type HostContextModuleMethod =
  | "prepare_for_model"
  | "apply_tool_results"
  | "recover_from_model_error"
  | "capture_turn";
export type HostCapabilityModuleMethod = "execute" | "execute_batch";
export type HostPermissionModuleMethod = "decide";
export type HostModuleCapabilities = {
  context?: { methods: HostContextModuleMethod[] };
  capability?: { methods: HostCapabilityModuleMethod[] };
  /** Host-owned policy decision before a sidecar dispatches a tool. */
  permission?: { methods: HostPermissionModuleMethod[] };
};
export type ModuleOperationState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "resolving"
  | "result_unknown";

export type ModuleBinding = {
  moduleInstanceId: string;
  connectionGeneration: string;
};

export type ModuleCapabilities = {
  capabilitiesVersion: string;
  methods: Array<{
    name: "execute" | "cancel" | "status" | "resume" | "ack";
    enabled?: boolean;
    profiles?: ModuleExecuteProfile[];
    cancel?: boolean;
    resumeSupport?: "none" | "streaming";
    retry?: ModuleRetryability;
    sideEffectClass?: "none" | "idempotent" | "non_idempotent";
    concurrency?: { mode: "parallel" | "serial"; limit?: number };
  }>;
};

export type ModuleMessageBase = {
  kind: "request" | "response" | "event" | "error";
  messageId?: string;
};

export type ModuleExecuteRequest = ModuleMessageBase & {
  kind: "request";
  messageId: string;
  method: "execute";
  runId: string;
  operationId: string;
  requestId: string;
  sessionId?: string;
  turnId?: string;
  idempotencyKey?: string;
  operationDeadline?: string;
  attemptDeadline?: string;
  payload: Record<string, unknown>;
};

export type ModuleControlRequest =
  | (ModuleMessageBase & {
      kind: "request";
      messageId: string;
      method: "cancel";
      runId: string;
      operationId: string;
      requestId?: string;
      reason: string;
    })
  | (ModuleMessageBase & { kind: "request"; messageId: string; method: "status"; requestId: string })
  | (ModuleMessageBase & {
      kind: "request";
      messageId: string;
      method: "resume";
      streamId: string;
      previousBinding: ModuleBinding;
      lastAppliedSequence: number;
    })
  | (ModuleMessageBase & {
      kind: "request";
      messageId: string;
      method: "ack";
      streamId: string;
      lastAppliedSequence: number;
    });

/** A request emitted by the AgentLoop sidecar to its host-owned modules. */
export type ModuleCallRequest = ModuleMessageBase & {
  kind: "request";
  messageId: string;
  method: "module_call";
  runId: string;
  operationId: string;
  requestId: string;
  module: "model" | "capability" | "permission" | "checkpoint" | "context";
  payload: Record<string, unknown>;
};

export type ModuleHandshakeRequest = ModuleMessageBase & {
  kind: "request";
  messageId: string;
  method: "hello" | "capabilities";
  payload: Record<string, unknown>;
};

export type ModuleResponse = ModuleMessageBase & {
  kind: "response";
  messageId: string;
  inReplyTo: string;
  requestId?: string;
  ok: boolean;
  streamId?: string;
  cursor?: number;
  replayedThroughSequence?: number;
  final?: boolean;
  outcome?: ModuleOutcome;
  code?: string;
  error?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  protocolVersion?: typeof MODULE_PROTOCOL_VERSION;
  moduleId?: string;
  moduleInstanceId?: string;
  connectionGeneration?: string;
  capabilitiesVersion?: string;
};

export type ModuleEvent = ModuleMessageBase & {
  kind: "event";
  eventType: string;
  streamId: string;
  sequence: number;
  runId: string;
  operationId: string;
  requestId: string;
  toolCallId?: string;
  final: boolean;
  outcome?: ModuleOutcome;
  error?: Record<string, unknown>;
  payload: Record<string, unknown>;
};

export type ModuleError = ModuleMessageBase & {
  kind: "error";
  messageId: string;
  code: string;
  message: string;
  retryability: ModuleRetryability;
};

export type ModuleMessage =
  | ModuleExecuteRequest
  | ModuleControlRequest
  | ModuleCallRequest
  | ModuleHandshakeRequest
  | ModuleResponse
  | ModuleEvent
  | ModuleError;

export type ModuleOperationSnapshot = {
  runId: string;
  operationId: string;
  state: ModuleOperationState;
  outcome?: ModuleOutcome;
  requestIds: string[];
  cancelRequested: boolean;
  updatedAt: string;
};

export type ModuleProtocolValidation = { ok: true } | { ok: false; code: string; message: string };

export function validateModuleMessage(value: unknown): ModuleProtocolValidation {
  if (!value || typeof value !== "object") return invalid("INVALID_MESSAGE", "Module message must be an object.");
  const message = value as Record<string, unknown>;
  if (message.kind !== "request" && message.kind !== "response" && message.kind !== "event" && message.kind !== "error") {
    return invalid("INVALID_KIND", "Module message kind is invalid.");
  }
  if (message.kind === "request" && typeof message.messageId !== "string") {
    return invalid("MISSING_MESSAGE_ID", "Request messageId is required.");
  }
  if (message.kind === "request" && message.method === "execute") {
    for (const field of ["runId", "operationId", "requestId", "payload"]) {
      if (!(field in message)) return invalid("MISSING_EXECUTE_FIELD", `Execute request field ${field} is required.`);
    }
    if ("attemptId" in message || "stepId" in message) return invalid("UNSUPPORTED_FIELD", "attemptId and stepId are not public fields.");
  }
  if (message.kind === "request" && message.method === "module_call") {
    for (const field of ["runId", "operationId", "requestId", "module", "payload"]) {
      if (!(field in message)) return invalid("MISSING_MODULE_CALL_FIELD", `Module call field ${field} is required.`);
    }
    if (!["model", "capability", "permission", "checkpoint", "context"].includes(String(message.module))) {
      return invalid("INVALID_MODULE", "Module call target is invalid.");
    }
  }
  if (message.kind === "event") {
    for (const field of ["eventType", "streamId", "sequence", "runId", "operationId", "requestId", "final", "payload"]) {
      if (!(field in message)) return invalid("MISSING_EVENT_FIELD", `Event field ${field} is required.`);
    }
    if (message.final === true && typeof message.outcome !== "string") return invalid("MISSING_OUTCOME", "Final event requires outcome.");
    if ("moduleInstanceId" in message || "connectionGeneration" in message) return invalid("UNSUPPORTED_FIELD", "Connection binding belongs to transport context.");
  }
  if (message.kind === "response" && message.final === true && typeof message.outcome !== "string") {
    return invalid("MISSING_OUTCOME", "Final response requires outcome.");
  }
  return { ok: true };
}

function invalid(code: string, message: string): ModuleProtocolValidation {
  return { ok: false, code, message };
}

type OperationRecord = {
  snapshot: ModuleOperationSnapshot;
  finalRequestIds: Set<string>;
  streamSequences: Map<string, number>;
};

/** Host-owned operation state and stream de-duplication for direct adapters. */
export class ModuleOperationHost {
  private readonly operations = new Map<string, OperationRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  accept(request: Pick<ModuleExecuteRequest, "runId" | "operationId" | "requestId">): ModuleOperationSnapshot {
    const existing = this.operations.get(request.operationId);
    if (existing) {
      if (existing.snapshot.runId !== request.runId) throw new Error("OPERATION_RUN_MISMATCH");
      if (!existing.snapshot.requestIds.includes(request.requestId)) existing.snapshot.requestIds.push(request.requestId);
      existing.snapshot.state = existing.snapshot.state === "pending" ? "running" : existing.snapshot.state;
      existing.snapshot.updatedAt = this.now().toISOString();
      return cloneSnapshot(existing.snapshot);
    }
    const snapshot: ModuleOperationSnapshot = {
      runId: request.runId,
      operationId: request.operationId,
      state: "running",
      requestIds: [request.requestId],
      cancelRequested: false,
      updatedAt: this.now().toISOString(),
    };
    this.operations.set(request.operationId, { snapshot, finalRequestIds: new Set(), streamSequences: new Map() });
    return cloneSnapshot(snapshot);
  }

  recordFinal(operationId: string, requestId: string, outcome: ModuleOutcome): ModuleOperationSnapshot {
    const record = this.require(operationId);
    if (record.finalRequestIds.has(requestId)) return cloneSnapshot(record.snapshot);
    if (record.snapshot.outcome) return cloneSnapshot(record.snapshot);
    record.finalRequestIds.add(requestId);
    record.snapshot.outcome = outcome;
    record.snapshot.state = outcome === "completed" ? "completed" : outcome === "cancelled" ? "cancelled" : outcome === "result_unknown" ? "resolving" : "failed";
    record.snapshot.updatedAt = this.now().toISOString();
    return cloneSnapshot(record.snapshot);
  }

  expire(operationId: string, requestId: string): ModuleOperationSnapshot {
    return this.recordFinal(operationId, requestId, "failed");
  }

  markResolving(operationId: string): ModuleOperationSnapshot {
    const record = this.require(operationId);
    if (!record.snapshot.outcome) {
      record.snapshot.state = "resolving";
      record.snapshot.updatedAt = this.now().toISOString();
    }
    return cloneSnapshot(record.snapshot);
  }

  requestCancel(operationId: string): ModuleOperationSnapshot {
    const record = this.require(operationId);
    if (!record.snapshot.outcome) {
      record.snapshot.cancelRequested = true;
      record.snapshot.state = "cancel_requested";
      record.snapshot.updatedAt = this.now().toISOString();
    }
    return cloneSnapshot(record.snapshot);
  }

  acceptSequence(operationId: string, streamId: string, sequence: number): { accepted: boolean; gap: boolean } {
    const record = this.require(operationId);
    const previous = record.streamSequences.get(streamId);
    if (previous !== undefined && sequence <= previous) return { accepted: false, gap: false };
    const gap = previous !== undefined && sequence > previous + 1;
    if (!gap) record.streamSequences.set(streamId, sequence);
    return { accepted: !gap, gap };
  }

  status(operationId: string): ModuleOperationSnapshot | undefined {
    const record = this.operations.get(operationId);
    return record ? cloneSnapshot(record.snapshot) : undefined;
  }

  private require(operationId: string): OperationRecord {
    const record = this.operations.get(operationId);
    if (!record) throw new Error(`UNKNOWN_OPERATION:${operationId}`);
    return record;
  }
}

export type InProcessModuleHandler = {
  capabilities: ModuleCapabilities;
  execute(request: ModuleExecuteRequest): AsyncIterable<{
    eventType: string;
    payload: Record<string, unknown>;
    final?: boolean;
    outcome?: ModuleOutcome;
    toolCallId?: string;
  }>;
  cancel?(request: Extract<ModuleControlRequest, { method: "cancel" }>): Promise<void> | void;
};

export type InProcessModuleOptions = {
  moduleId: string;
  moduleInstanceId?: string;
  now?: () => Date;
  uuid?: () => string;
};

/** Direct, transport-free v2 adapter used by AgentLoop and contract tests. */
export class InProcessModuleAdapter {
  readonly moduleId: string;
  readonly moduleInstanceId: string;
  readonly connectionGeneration: string;
  private readonly host: ModuleOperationHost;
  private readonly streams = new Map<string, ModuleEvent[]>();
  private readonly requestOperations = new Map<string, string>();
  private readonly uuid: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly handler: InProcessModuleHandler,
    options: InProcessModuleOptions,
  ) {
    this.moduleId = options.moduleId;
    this.moduleInstanceId = options.moduleInstanceId ?? options.uuid?.() ?? `${options.moduleId}-instance`;
    this.connectionGeneration = options.uuid?.() ?? `${this.moduleInstanceId}-connection`;
    this.host = new ModuleOperationHost(options.now);
    this.uuid = options.uuid ?? (() => Math.random().toString(36).slice(2));
    this.now = options.now ?? (() => new Date());
  }

  hello(request: ModuleHandshakeRequest): ModuleResponse {
    return {
      kind: "response",
      messageId: this.nextId("hello"),
      inReplyTo: request.messageId,
      ok: true,
      protocolVersion: MODULE_PROTOCOL_VERSION,
      moduleId: this.moduleId,
      moduleInstanceId: this.moduleInstanceId,
      connectionGeneration: this.connectionGeneration,
      capabilitiesVersion: this.handler.capabilities.capabilitiesVersion,
      payload: {},
    };
  }

  capabilities(request: ModuleHandshakeRequest): ModuleResponse {
    return {
      kind: "response",
      messageId: this.nextId("capabilities"),
      inReplyTo: request.messageId,
      ok: true,
      protocolVersion: MODULE_PROTOCOL_VERSION,
      moduleId: this.moduleId,
      moduleInstanceId: this.moduleInstanceId,
      connectionGeneration: this.connectionGeneration,
      capabilitiesVersion: this.handler.capabilities.capabilitiesVersion,
      payload: this.handler.capabilities as unknown as Record<string, unknown>,
    };
  }

  async *execute(request: ModuleExecuteRequest): AsyncGenerator<ModuleResponse | ModuleEvent | ModuleError> {
    const validation = validateModuleMessage(request);
    if (!validation.ok) {
      yield { kind: "error", messageId: this.nextId("error"), code: validation.code, message: validation.message, retryability: "unsafe" };
      return;
    }
    this.host.accept(request);
    this.requestOperations.set(request.requestId, request.operationId);
    const deadline = request.attemptDeadline ?? request.operationDeadline;
    if (deadline && Date.parse(deadline) <= this.now().getTime()) {
      this.host.expire(request.operationId, request.requestId);
      yield {
        kind: "response",
        messageId: this.nextId("deadline"),
        inReplyTo: request.messageId,
        requestId: request.requestId,
        ok: false,
        final: true,
        outcome: "failed",
        code: "DEADLINE_EXCEEDED",
      };
      return;
    }
    const executeMethod = this.handler.capabilities.methods.find((method) => method.name === "execute");
    const streaming = executeMethod?.profiles?.includes("streaming") === true;
    if (!streaming) {
      let payload: Record<string, unknown> = {};
      let outcome: ModuleOutcome = "completed";
      try {
        for await (const item of this.handler.execute(request)) {
          payload = item.payload;
          if (item.outcome) outcome = item.outcome;
        }
        this.host.recordFinal(request.operationId, request.requestId, outcome);
        yield {
          kind: "response",
          messageId: this.nextId("completed"),
          inReplyTo: request.messageId,
          requestId: request.requestId,
          ok: outcome === "completed",
          final: true,
          outcome,
          payload,
        };
      } catch (error) {
        this.host.recordFinal(request.operationId, request.requestId, "failed");
        yield {
          kind: "response",
          messageId: this.nextId("failed"),
          inReplyTo: request.messageId,
          requestId: request.requestId,
          ok: false,
          final: true,
          outcome: "failed",
          code: "MODULE_EXECUTION_FAILED",
          error: { message: error instanceof Error ? error.message : String(error) },
        };
      }
      return;
    }
    const streamId = this.nextId("stream");
    const accepted: ModuleResponse = {
      kind: "response",
      messageId: this.nextId("accepted"),
      inReplyTo: request.messageId,
      requestId: request.requestId,
      ok: true,
      streamId,
      cursor: 0,
    };
    yield accepted;
    const history: ModuleEvent[] = [];
    this.streams.set(streamId, history);
    let sequence = 0;
    let finalSeen = false;
    try {
      for await (const item of this.handler.execute(request)) {
        if (finalSeen) continue;
        const event: ModuleEvent = {
          kind: "event",
          eventType: item.eventType,
          streamId,
          sequence: sequence++,
          runId: request.runId,
          operationId: request.operationId,
          requestId: request.requestId,
          ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
          final: item.final === true,
          ...(item.outcome ? { outcome: item.outcome } : {}),
          payload: item.payload,
        };
        const acceptedSequence = this.host.acceptSequence(request.operationId, streamId, event.sequence);
        if (!acceptedSequence.accepted) {
          if (acceptedSequence.gap) throw new Error("SEQUENCE_GAP");
          continue;
        }
        history.push(event);
        if (event.final) {
          finalSeen = true;
          this.host.recordFinal(request.operationId, request.requestId, event.outcome ?? "completed");
        }
        yield event;
      }
      if (!finalSeen) {
        const event: ModuleEvent = {
          kind: "event",
          eventType: "execute.completed",
          streamId,
          sequence: sequence++,
          runId: request.runId,
          operationId: request.operationId,
          requestId: request.requestId,
          final: true,
          outcome: "completed",
          payload: {},
        };
        history.push(event);
        this.host.recordFinal(request.operationId, request.requestId, "completed");
        yield event;
      }
    } catch (error) {
      this.host.recordFinal(request.operationId, request.requestId, "failed");
      yield {
        kind: "error",
        messageId: this.nextId("error"),
        code: "MODULE_EXECUTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryability: "retry_after_status",
      };
    }
  }

  cancel(request: Extract<ModuleControlRequest, { method: "cancel" }>): ModuleResponse {
    let snapshot: ModuleOperationSnapshot;
    try {
      snapshot = this.host.requestCancel(request.operationId);
    } catch {
      return {
        kind: "response",
        messageId: this.nextId("cancel"),
        inReplyTo: request.messageId,
        ok: false,
        code: "UNKNOWN_OPERATION",
      };
    }
    void this.handler.cancel?.(request);
    return {
      kind: "response",
      messageId: this.nextId("cancel"),
      inReplyTo: request.messageId,
      ok: true,
      requestId: request.requestId,
      payload: snapshot as unknown as Record<string, unknown>,
    };
  }

  status(request: Extract<ModuleControlRequest, { method: "status" }>): ModuleResponse {
    const operationId = this.requestOperations.get(request.requestId);
    const snapshot = operationId ? this.host.status(operationId) : undefined;
    return {
      kind: "response",
      messageId: this.nextId("status"),
      inReplyTo: request.messageId,
      requestId: request.requestId,
      ok: snapshot !== undefined,
      ...(snapshot ? { payload: snapshot as unknown as Record<string, unknown> } : { code: "UNKNOWN_REQUEST" }),
    };
  }

  resume(request: Extract<ModuleControlRequest, { method: "resume" }>): ModuleResponse | ModuleEvent[] {
    if (request.previousBinding.moduleInstanceId !== this.moduleInstanceId
      || request.previousBinding.connectionGeneration !== this.connectionGeneration) {
      return {
        kind: "response",
        messageId: this.nextId("resume"),
        inReplyTo: request.messageId,
        ok: false,
        code: "BINDING_MISMATCH",
      };
    }
    const history = this.streams.get(request.streamId);
    if (!history) {
      return {
        kind: "response",
        messageId: this.nextId("resume"),
        inReplyTo: request.messageId,
        ok: false,
        code: "CURSOR_EXPIRED",
      };
    }
    const replay = history.filter((event) => event.sequence > request.lastAppliedSequence);
    return replay;
  }

  ack(request: Extract<ModuleControlRequest, { method: "ack" }>): ModuleResponse {
    return {
      kind: "response",
      messageId: this.nextId("ack"),
      inReplyTo: request.messageId,
      ok: this.streams.has(request.streamId),
      ...(this.streams.has(request.streamId) ? {} : { code: "CURSOR_EXPIRED" }),
    };
  }

  private nextId(prefix: string): string {
    return `${prefix}-${this.uuid()}`;
  }
}

function cloneSnapshot(snapshot: ModuleOperationSnapshot): ModuleOperationSnapshot {
  return { ...snapshot, requestIds: [...snapshot.requestIds] };
}

/** Narrow model adapter contract used by AgentLoop. */
export type ModelExecutionContext = {
  sessionId: string;
  turnId: string;
  runId: string;
  operationId?: string;
  idempotencyKey?: string;
  operationDeadline?: string;
  abortSignal?: AbortSignal;
  metadata?: Record<string, unknown>;
  modelOverride?: { provider: string; model: string };
  /**
   * Optional, serialized Gateway session restriction. This is not a model
   * configuration or credential surface; it only narrows candidate execution.
   */
  managedModelPolicy?: { allow: string[]; deny: string[] };
};

export type AgentExecutionContext = ModelExecutionContext;

export type PreparedModelInvocation = {
  request: import("../../model/index.js").CanonicalModelRequest;
  provider: string;
  model: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  opaque?: unknown;
};

export type ModelInvokerPort = {
  prepare(input: {
    request: import("../../model/index.js").CanonicalModelRequest;
    context: ModelExecutionContext;
  }): Promise<PreparedModelInvocation>;
  stream(input: {
    prepared: PreparedModelInvocation;
    context: ModelExecutionContext;
  }): AsyncIterable<import("../../model/index.js").CanonicalModelEvent>;
};

export type ToolPort = {
  list(): import("../../tool/index.js").PilotDeckToolDefinition[];
  executeAll(
    calls: import("../../tool/index.js").PilotDeckToolCall[],
    context: import("../../tool/index.js").PilotDeckToolRuntimeContext,
    execution: ModelExecutionContext,
  ): Promise<import("../../tool/index.js").PilotDeckToolResult[]>;
};
