export const MODULE_PROTOCOL_VERSION = "2.0" as const;

export type ModuleOutcome = "completed" | "failed" | "cancelled" | "result_unknown";
export type ModuleExecuteProfile = "unary" | "streaming" | "side_effect" | "tool";
export type ModuleRetryability = "safe" | "unsafe" | "retry_after_status";

/** Host-advertised context operations supported by Module Protocol v2. */
export const HOST_CONTEXT_MODULE_METHODS = [
  "prepare_for_model",
  "apply_tool_results",
  "recover_from_model_error",
  "capture_turn",
  "try_auto_compact",
] as const;

/** Host-advertised model operations supported by Module Protocol v2. */
export const HOST_MODEL_MODULE_METHODS = ["prepare", "stream", "stream_next", "close_stream", "get_metadata"] as const;

/** Host-advertised model-budget operations supported by Module Protocol v2. */
export const HOST_BUDGET_MODULE_METHODS = [
  "estimate_request_input",
  "evaluate_request_budget",
  "estimate_usage_cost",
] as const;

/** Host-advertised active-turn operations supported by Module Protocol v2. */
export const HOST_TURN_MODULE_METHODS = [
  "drain_steer",
  "drain_or_close_steer",
  "persist_compaction",
] as const;

/** Host-advertised capability operations supported by Module Protocol v2. */
export const HOST_CAPABILITY_MODULE_METHODS = ["execute", "execute_batch", "plan_todo"] as const;

/** Host-advertised permission operations supported by Module Protocol v2. */
export const HOST_PERMISSION_MODULE_METHODS = ["decide"] as const;

/** Host-advertised lifecycle operations supported by Module Protocol v2. */
export const HOST_LIFECYCLE_MODULE_METHODS = ["dispatch"] as const;

/** Host-advertised volatile agent-event operations supported by Module Protocol v2. */
export const HOST_EVENT_MODULE_METHODS = ["emit"] as const;

export type HostContextModuleMethod = (typeof HOST_CONTEXT_MODULE_METHODS)[number];
export type HostModelModuleMethod = (typeof HOST_MODEL_MODULE_METHODS)[number];
export type HostBudgetModuleMethod = (typeof HOST_BUDGET_MODULE_METHODS)[number];
export type HostTurnModuleMethod = (typeof HOST_TURN_MODULE_METHODS)[number];
export type HostCapabilityModuleMethod = (typeof HOST_CAPABILITY_MODULE_METHODS)[number];
export type HostPermissionModuleMethod = (typeof HOST_PERMISSION_MODULE_METHODS)[number];
export type HostLifecycleModuleMethod = (typeof HOST_LIFECYCLE_MODULE_METHODS)[number];
export type HostEventModuleMethod = (typeof HOST_EVENT_MODULE_METHODS)[number];
export type HostModuleCapabilities = {
  model?: { methods: HostModelModuleMethod[] };
  budget?: { methods: HostBudgetModuleMethod[] };
  turn?: { methods: HostTurnModuleMethod[] };
  context?: { methods: HostContextModuleMethod[] };
  capability?: { methods: HostCapabilityModuleMethod[] };
  permission?: { methods: HostPermissionModuleMethod[] };
  lifecycle?: { methods: HostLifecycleModuleMethod[] };
  event?: { methods: HostEventModuleMethod[] };
};

export function readHostModelModuleMethods(value: unknown): HostModelModuleMethod[] {
  return readHostModuleMethods(value, HOST_MODEL_MODULE_METHODS);
}

export function readHostBudgetModuleMethods(value: unknown): HostBudgetModuleMethod[] {
  return readHostModuleMethods(value, HOST_BUDGET_MODULE_METHODS);
}

export function readHostTurnModuleMethods(value: unknown): HostTurnModuleMethod[] {
  return readHostModuleMethods(value, HOST_TURN_MODULE_METHODS);
}

export function readHostContextModuleMethods(value: unknown): HostContextModuleMethod[] {
  return readHostModuleMethods(value, HOST_CONTEXT_MODULE_METHODS);
}

export function readHostCapabilityModuleMethods(value: unknown): HostCapabilityModuleMethod[] {
  return readHostModuleMethods(value, HOST_CAPABILITY_MODULE_METHODS);
}

export function readHostPermissionModuleMethods(value: unknown): HostPermissionModuleMethod[] {
  return readHostModuleMethods(value, HOST_PERMISSION_MODULE_METHODS);
}

export function readHostLifecycleModuleMethods(value: unknown): HostLifecycleModuleMethod[] {
  return readHostModuleMethods(value, HOST_LIFECYCLE_MODULE_METHODS);
}

export function readHostEventModuleMethods(value: unknown): HostEventModuleMethod[] {
  return readHostModuleMethods(value, HOST_EVENT_MODULE_METHODS);
}
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
  idempotencyKey?: string;
  module: "model" | "budget" | "turn" | "capability" | "permission" | "checkpoint" | "context" | "skills" | "knowledge" | "lifecycle" | "event";
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
  code?: string;
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
  if (!isRecord(value)) return invalid("INVALID_MESSAGE", "Module message must be an object.");
  const message = value as Record<string, unknown>;
  if (message.kind !== "request" && message.kind !== "response" && message.kind !== "event" && message.kind !== "error") {
    return invalid("INVALID_KIND", "Module message kind is invalid.");
  }
  if (message.kind !== "event" && !isId(message.messageId)) {
    return invalid("MISSING_MESSAGE_ID", "Message messageId is required.");
  }
  if (message.kind === "event" && message.messageId !== undefined && !isId(message.messageId)) {
    return invalid("INVALID_EVENT_FIELD", "Event messageId is invalid.");
  }
  if (message.kind === "request") {
    if (message.method === "execute") {
      for (const field of ["runId", "operationId", "requestId"] as const) {
        if (!isId(message[field])) return invalid("MISSING_EXECUTE_FIELD", `Execute request field ${field} is required.`);
      }
      if (!isRecord(message.payload)) return invalid("MISSING_EXECUTE_FIELD", "Execute request field payload is required.");
      if (message.idempotencyKey !== undefined && !isId(message.idempotencyKey)) return invalid("INVALID_EXECUTE_FIELD", "Execute request idempotencyKey is invalid.");
      if (message.operationDeadline !== undefined && typeof message.operationDeadline !== "string") return invalid("INVALID_EXECUTE_FIELD", "Execute request operationDeadline is invalid.");
      if (message.attemptDeadline !== undefined && typeof message.attemptDeadline !== "string") return invalid("INVALID_EXECUTE_FIELD", "Execute request attemptDeadline is invalid.");
      if ("attemptId" in message || "stepId" in message) return invalid("UNSUPPORTED_FIELD", "attemptId and stepId are not public fields.");
      return { ok: true };
    }
    if (message.method === "module_call") {
      for (const field of ["runId", "operationId", "requestId"] as const) {
        if (!isId(message[field])) return invalid("MISSING_MODULE_CALL_FIELD", `Module call field ${field} is required.`);
      }
      if (!isRecord(message.payload)) return invalid("MISSING_MODULE_CALL_FIELD", "Module call field payload is required.");
      if (message.idempotencyKey !== undefined && !isId(message.idempotencyKey)) return invalid("INVALID_MODULE_CALL_FIELD", "Module call idempotencyKey is invalid.");
      if (!MODULE_CALL_TARGETS.includes(message.module as ModuleCallRequest["module"])) {
        return invalid("INVALID_MODULE", "Module call target is invalid.");
      }
      return { ok: true };
    }
    if (message.method === "cancel") {
      if (!isId(message.runId) || !isId(message.operationId) || typeof message.reason !== "string" || message.reason.length === 0) {
        return invalid("INVALID_CANCEL_REQUEST", "Cancel requires runId, operationId, and reason.");
      }
      if (message.requestId !== undefined && !isId(message.requestId)) return invalid("INVALID_CANCEL_REQUEST", "Cancel requestId is invalid.");
      return { ok: true };
    }
    if (message.method === "status") {
      return isId(message.requestId)
        ? { ok: true }
        : invalid("INVALID_STATUS_REQUEST", "Status requires requestId.");
    }
    if (message.method === "resume") {
      if (!isId(message.streamId) || !isBinding(message.previousBinding) || !isResumeSequence(message.lastAppliedSequence)) {
        return invalid("INVALID_RESUME_REQUEST", "Resume requires streamId, previousBinding, and lastAppliedSequence.");
      }
      return { ok: true };
    }
    if (message.method === "ack") {
      if (!isId(message.streamId) || !isSequence(message.lastAppliedSequence)) {
        return invalid("INVALID_ACK_REQUEST", "Ack requires streamId and lastAppliedSequence.");
      }
      return { ok: true };
    }
    if (message.method === "hello" || message.method === "capabilities") {
      return isRecord(message.payload)
        ? { ok: true }
        : invalid("INVALID_HANDSHAKE_REQUEST", "Handshake requires payload.");
    }
    return invalid("INVALID_METHOD", "Module request method is invalid.");
  }
  if (message.kind === "event") {
    for (const field of ["eventType", "streamId", "runId", "operationId", "requestId"] as const) {
      if (!isId(message[field])) return invalid("MISSING_EVENT_FIELD", `Event field ${field} is required.`);
    }
    if (!isSequence(message.sequence) || typeof message.final !== "boolean" || !isRecord(message.payload)) {
      return invalid("MISSING_EVENT_FIELD", "Event sequence, final, and payload are required.");
    }
    if (message.final === true && !isOutcome(message.outcome)) return invalid("MISSING_OUTCOME", "Final event requires outcome.");
    if (message.outcome !== undefined && !isOutcome(message.outcome)) return invalid("INVALID_OUTCOME", "Event outcome is invalid.");
    if (message.code !== undefined && !isId(message.code)) return invalid("INVALID_EVENT_FIELD", "Event code is invalid.");
    if ("moduleInstanceId" in message || "connectionGeneration" in message) return invalid("UNSUPPORTED_FIELD", "Connection binding belongs to transport context.");
    return { ok: true };
  }
  if (message.kind === "response") {
    if (!isId(message.inReplyTo) || typeof message.ok !== "boolean") {
      return invalid("INVALID_RESPONSE", "Response requires inReplyTo and ok.");
    }
    if (message.final === true && !isOutcome(message.outcome)) return invalid("MISSING_OUTCOME", "Final response requires outcome.");
    if (message.outcome !== undefined && !isOutcome(message.outcome)) return invalid("INVALID_OUTCOME", "Response outcome is invalid.");
    return { ok: true };
  }
  if (!isId(message.code) || typeof message.message !== "string" || message.message.length === 0) {
    return invalid("INVALID_ERROR", "Error requires code and message.");
  }
  if (message.retryability !== "safe" && message.retryability !== "unsafe" && message.retryability !== "retry_after_status") {
    return invalid("INVALID_ERROR", "Error retryability is invalid.");
  }
  return { ok: true };
}

const MODULE_CALL_TARGETS: ModuleCallRequest["module"][] = [
  "model",
  "budget",
  "turn",
  "capability",
  "permission",
  "checkpoint",
  "context",
  "skills",
  "knowledge",
  "lifecycle",
  "event",
];

function readHostModuleMethods<Method extends string>(
  value: unknown,
  supported: readonly Method[],
): Method[] {
  return Array.isArray(value)
    ? value.filter((method): method is Method => typeof method === "string" && supported.includes(method as Method))
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isResumeSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= -1;
}

function isOutcome(value: unknown): value is ModuleOutcome {
  return value === "completed" || value === "failed" || value === "cancelled" || value === "result_unknown";
}

function isBinding(value: unknown): value is ModuleBinding {
  return isRecord(value) && isId(value.moduleInstanceId) && isId(value.connectionGeneration);
}

function invalid(code: string, message: string): ModuleProtocolValidation {
  return { ok: false, code, message };
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

/** Result of authorizing one tool call before any capability side effect. */
export type ToolAuthorizationOutcome =
  | { call: import("../../tool/index.js").PilotDeckToolCall }
  | { result: import("../../tool/index.js").PilotDeckToolResult };

/**
 * Host policy boundary for tool admission. Execution providers do not own
 * permission decisions; a composition can replace either side independently.
 */
export type ToolAuthorizationPort = {
  authorize(
    call: import("../../tool/index.js").PilotDeckToolCall,
    context: import("../../tool/index.js").PilotDeckToolRuntimeContext,
  ): Promise<ToolAuthorizationOutcome>;
};
