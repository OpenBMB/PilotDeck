import { createInterface } from "node:readline";
import type { Writable, Readable } from "node:stream";
import type { AgentLoop, AgentLoopInput } from "../loop/AgentLoop.js";
import type { AgentEvent } from "../protocol/events.js";
import type { CanonicalModelEvent } from "../../model/index.js";
import type {
  AgentContextCaptureTurnInput,
  AgentContextPrepareInput,
  AgentContextRecoveryInput,
  AgentContextRuntime,
  AgentContextToolResultInput,
} from "../../context/index.js";
import type { PilotDeckToolDefinition, PilotDeckToolResult, PilotDeckToolRuntimeContext, PilotDeckToolCall, PilotDeckToolErrorCode } from "../../tool/index.js";
import { buildToolErrorRecovery } from "../../tool/execution/errorRecovery.js";
import { toolError } from "../../tool/protocol/errors.js";
import type { AgentExecutionContext, ModelInvokerPort, PreparedModelInvocation, ToolPort } from "./protocol.js";
import {
  MODULE_PROTOCOL_VERSION,
  type HostCapabilityModuleMethod,
  type HostContextModuleMethod,
  type HostPermissionModuleMethod,
  type ModuleCallRequest,
  type ModuleCapabilities,
  type ModuleExecuteRequest,
  type ModuleMessage,
  type ModuleResponse,
  type ModuleOutcome,
  validateModuleMessage,
} from "./protocol.js";

export type SidecarModuleCall = Omit<ModuleCallRequest, "kind" | "messageId" | "method"> & {
  idempotencyKey?: string;
  /** Internal aggregation hint; it is not serialized into Module Protocol. */
  recordFailure?: boolean;
};

export type SidecarModuleCallClient = (request: SidecarModuleCall) => Promise<ModuleResponse>;

export type SidecarModuleBinding = {
  runId: string;
  operationId: string;
  idempotencyKey?: string;
};

/** Build a context runtime whose state and prompt policy remain owned by the host. */
export function createSidecarContextRuntime(
  callModule: SidecarModuleCallClient,
  binding: SidecarModuleBinding,
  methods: readonly HostContextModuleMethod[],
  uuid: () => string = () => Math.random().toString(36).slice(2),
): AgentContextRuntime {
  const supported = new Set(methods);
  if (!supported.has("prepare_for_model")) {
    throw new Error("Host context module must support prepare_for_model.");
  }
  const invoke = async <T>(operation: HostContextModuleMethod, input: object): Promise<T> => {
    const response = await callModule({
      ...binding,
      requestId: `context-${operation}-${uuid()}`,
      module: "context",
      recordFailure: operation === "prepare_for_model",
      payload: { operation, input: serializeContextInput(input) },
    });
    if (!response.ok) {
      const failure = new Error(String(response.error?.message ?? response.code ?? `Context module ${operation} failed.`)) as Error & { code?: string };
      failure.code = response.code;
      throw failure;
    }
    if (!response.payload || !("result" in response.payload)) {
      throw new Error(`Context module ${operation} returned no result.`);
    }
    return response.payload.result as T;
  };
  const runtime: AgentContextRuntime = {
    prepareForModel: (input: AgentContextPrepareInput) => invoke("prepare_for_model", input),
  };
  if (supported.has("apply_tool_results")) {
    runtime.applyToolResults = (input: AgentContextToolResultInput) => invoke("apply_tool_results", input);
  }
  if (supported.has("recover_from_model_error")) {
    runtime.recoverFromModelError = (input: AgentContextRecoveryInput) => invoke("recover_from_model_error", input);
  }
  if (supported.has("capture_turn")) {
    runtime.captureTurn = async (input: AgentContextCaptureTurnInput) => {
      await invoke("capture_turn", input);
    };
  }
  return runtime;
}

/** Build AgentLoop ports backed by host-owned modules over the sidecar stream. */
export function createSidecarPorts(
  callModule: SidecarModuleCallClient,
  options: {
    tools?: PilotDeckToolDefinition[];
    uuid?: () => string;
    capabilityMethods?: readonly HostCapabilityModuleMethod[];
    /** Enables host-owned permission decisions before capability dispatch. */
    permissionMethods?: readonly HostPermissionModuleMethod[];
    onAbort?: (reason: string) => void;
  } = {},
): { model: ModelInvokerPort; tools: ToolPort } {
  const uuid = options.uuid ?? (() => Math.random().toString(36).slice(2));
  const usesHostPermission = options.permissionMethods?.includes("decide") ?? false;
  return {
    model: {
      async prepare({ request }): Promise<PreparedModelInvocation> {
        return { request, provider: request.provider, model: request.model };
      },
      async *stream({ prepared, context }): AsyncIterable<CanonicalModelEvent> {
        const response = await callModule({
          runId: context.runId,
          operationId: context.operationId ?? context.turnId,
          idempotencyKey: context.idempotencyKey,
          requestId: `model-${uuid()}`,
          module: "model",
          payload: { request: prepared.request, context },
        });
        if (!response.ok) {
          const failure = new Error(String(response.error?.message ?? response.code ?? "Model module failed")) as Error & { code?: string };
          failure.code = response.code;
          throw failure;
        }
        const events = response.payload?.events;
        if (!Array.isArray(events)) return;
        for (const event of events) yield event as CanonicalModelEvent;
      },
    },
    tools: {
      list: () => options.tools ?? [],
      async executeAll(calls: PilotDeckToolCall[], context: PilotDeckToolRuntimeContext, execution): Promise<PilotDeckToolResult[]> {
        // A capability batch has no per-call permission response. Fall back to
        // the normal path when the host owns permission so a batch cannot
        // bypass an advertised policy boundary.
        if (!usesHostPermission && options.capabilityMethods?.includes("execute_batch") && calls.length > 0) {
          const response = await callModule({
            runId: execution.runId,
            operationId: execution.operationId ?? execution.turnId,
            idempotencyKey: execution.idempotencyKey,
            requestId: `tool-batch-${uuid()}`,
            module: "capability",
            payload: {
              operation: "execute_batch",
              calls: calls.map((call) => ({ name: call.name, arguments: call.input, toolCallId: call.id })),
              context: serializeToolContext(context),
              execution: serializeExecutionContext(execution),
            },
          });
          const results = response.payload?.results;
          if (!response.ok) return calls.map((call) => moduleFailureResult(call, response));
          if (!Array.isArray(results) || results.length !== calls.length) {
            throw new Error("Capability batch response must contain one result for every call.");
          }
          return results.map((result, index) => normalizeHostToolResult(
            validateBatchToolResult(result, calls[index]!, index),
            calls[index]!,
            context,
          ));
        }
        const resultSlots = new Array<PilotDeckToolResult | undefined>(calls.length);
        const concurrent: Array<{ index: number; call: PilotDeckToolCall }> = [];
        const sequential: Array<{ index: number; call: PilotDeckToolCall }> = [];
        const toolsByName = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
        for (let index = 0; index < calls.length; index++) {
          const call = calls[index]!;
          const tool = toolsByName.get(call.name);
          if (tool?.isConcurrencySafe(call.input)) concurrent.push({ index, call });
          else sequential.push({ index, call });
        }
        const execute = async (call: PilotDeckToolCall): Promise<PilotDeckToolResult> => {
          if (execution.abortSignal?.aborted) {
            throw new Error("Tool execution cancelled.");
          }
          const tool = toolsByName.get(call.name);
          const permission = usesHostPermission
            ? await resolveHostPermission(callModule, uuid, call, tool, context, execution)
            : { type: "allow" as const, input: call.input };
          if (permission.type === "result") return permission.result;
          const response = await callModule({
            runId: execution.runId,
            operationId: execution.operationId ?? execution.turnId,
            idempotencyKey: execution.idempotencyKey,
            requestId: `tool-${uuid()}`,
            module: "capability",
            payload: {
              name: call.name,
              arguments: permission.input,
              toolCallId: call.id,
              context: serializeToolContext(context),
              execution: serializeExecutionContext(execution),
            },
          });
          // A host cancel can arrive while the module call is in flight. Do
          // not let the completed response re-enter AgentLoop and trigger a
          // follow-up model turn after cancellation has been linearized.
          if (execution.abortSignal?.aborted) {
            throw new Error("Tool execution cancelled.");
          }
          const payload = response.payload;
          const responseError = response.error;
          const responseErrorCode = String(response.code ?? responseError?.code ?? "").toUpperCase();
          const responseErrorMessage = String(responseError?.message ?? "");
          if (
            !response.ok
            && (
              ["CANCELLED", "ABORTED", "TOOL_ABORTED"].includes(responseErrorCode)
              || /\bcancel(?:led|lation)?\b/i.test(`${responseErrorCode} ${responseErrorMessage}`)
            )
          ) {
            options.onAbort?.("tool_cancelled");
            throw new Error("Tool execution cancelled.");
          }
          // Host-owned tools may observe cancellation and return a structured
          // cancellation error before the sidecar receives the control frame.
          // Treat that result as terminal cancellation so AgentLoop does not
          // schedule another model turn after the cancelled action.
          if (
            response.ok
            && payload
            && typeof payload === "object"
            && payload.type === "error"
            && payload.error
            && typeof payload.error === "object"
            && (
              ["CANCELLED", "ABORTED", "TOOL_ABORTED"].includes(String((payload.error as Record<string, unknown>).code ?? "").toUpperCase())
              || /\bcancel(?:led|lation)?\b/i.test(String((payload.error as Record<string, unknown>).message ?? ""))
            )
          ) {
            options.onAbort?.("tool_cancelled");
            throw new Error("Tool execution cancelled.");
          }
          if (response.ok && payload && typeof payload === "object" && "type" in payload) {
            return normalizeHostToolResult(payload as unknown as PilotDeckToolResult, call, context);
          }
          return moduleFailureResult(call, response);
        };
        await Promise.all(concurrent.map(async ({ index, call }) => {
          resultSlots[index] = await execute(call);
        }));
        for (const { index, call } of sequential) {
          resultSlots[index] = await execute(call);
        }
        return resultSlots as PilotDeckToolResult[];
      },
    },
  };
}

type HostPermissionResolution =
  | { type: "allow"; input: unknown }
  | { type: "result"; result: PilotDeckToolResult };

async function resolveHostPermission(
  callModule: SidecarModuleCallClient,
  uuid: () => string,
  call: PilotDeckToolCall,
  tool: PilotDeckToolDefinition | undefined,
  context: PilotDeckToolRuntimeContext,
  execution: AgentExecutionContext,
): Promise<HostPermissionResolution> {
  const response = await callModule({
    runId: execution.runId,
    operationId: execution.operationId ?? execution.turnId,
    idempotencyKey: execution.idempotencyKey,
    requestId: `permission-${uuid()}`,
    module: "permission",
    payload: {
      operation: "decide",
      tool: serializePermissionTool(call.name, tool, call.input),
      input: call.input,
      toolCallId: call.id,
      context: serializeToolContext(context),
      execution: serializeExecutionContext(execution),
    },
  });
  if (!response.ok) {
    return {
      type: "result",
      result: hostPermissionError(
        call,
        "permission_required",
        String(response.error?.message ?? response.code ?? "Host permission module failed."),
        context,
      ),
    };
  }

  const decision = asRecord(response.payload?.decision);
  if (!decision) {
    return {
      type: "result",
      result: hostPermissionError(call, "permission_required", "Host permission module returned an invalid decision.", context),
    };
  }
  if (decision.type === "allow") {
    return { type: "allow", input: decision.updatedInput ?? call.input };
  }
  if (decision.type === "deny") {
    return {
      type: "result",
      result: hostPermissionError(call, "permission_denied", asNonEmptyString(decision.message) ?? `Permission denied for ${call.name}.`, context),
    };
  }
  if (decision.type === "cancel") {
    return {
      type: "result",
      result: hostPermissionError(call, "permission_cancelled", asNonEmptyString(decision.message) ?? `Permission cancelled for ${call.name}.`, context),
    };
  }
  if (decision.type === "ask") {
    return {
      type: "result",
      result: hostPermissionError(call, "permission_required", `Permission is required to run ${call.name}.`, context),
    };
  }
  return {
    type: "result",
    result: hostPermissionError(call, "permission_required", "Host permission module returned an invalid decision.", context),
  };
}

function serializePermissionTool(name: string, tool: PilotDeckToolDefinition | undefined, input: unknown): Record<string, unknown> {
  return {
    name,
    ...(tool ? {
      description: tool.description,
      kind: tool.kind,
      inputSchema: tool.inputSchema,
      readOnly: tool.isReadOnly(input),
    } : {}),
  };
}

function hostPermissionError(
  call: PilotDeckToolCall,
  code: Extract<PilotDeckToolErrorCode, "permission_denied" | "permission_cancelled" | "permission_required">,
  message: string,
  context: PilotDeckToolRuntimeContext,
): PilotDeckToolResult {
  const timestamp = new Date().toISOString();
  const recovery = buildToolErrorRecovery({
    code,
    toolName: call.name,
    message,
    cwd: context.cwd,
    permissionMode: context.permissionMode,
  });
  return {
    type: "error",
    toolCallId: call.id,
    toolName: call.name,
    error: toolError(code, message),
    content: [{ type: "text", text: recovery.message }],
    metadata: { recovery: recovery.advice },
    startedAt: timestamp,
    completedAt: timestamp,
  };
}

/**
 * A host module can return an already canonical PilotDeck tool error. For a
 * bare or foreign error, use the same recovery projection as ToolRuntime so
 * the next model request has identical error semantics in native and sidecar
 * execution.
 */
function normalizeHostToolResult(
  result: PilotDeckToolResult,
  call: PilotDeckToolCall,
  context: PilotDeckToolRuntimeContext,
): PilotDeckToolResult {
  if (result.type !== "error" || asRecord(result.metadata)?.recovery !== undefined) return result;
  const code = asToolErrorCode(result.error.code);
  const message = asNonEmptyString(result.error.message) ?? "Host capability execution failed.";
  const details = asRecord(result.error.details);
  const recovery = buildToolErrorRecovery({
    code,
    toolName: result.toolName || call.name,
    message,
    cwd: context.cwd,
    permissionMode: context.permissionMode,
    ...(details ? { details } : {}),
  });
  return {
    ...result,
    toolCallId: call.id,
    toolName: result.toolName || call.name,
    error: toolError(code, message, details),
    content: [{ type: "text", text: recovery.message }],
    metadata: { ...(result.metadata ?? {}), recovery: recovery.advice },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function serializeContextInput(input: object): Record<string, unknown> {
  const source = input as Record<string, unknown>;
  const { abortSignal: _abortSignal, budgetEvaluator: _budgetEvaluator, ...serializable } = source;
  return serializable;
}

function validateBatchToolResult(result: unknown, call: PilotDeckToolCall, index: number): PilotDeckToolResult {
  if (!result || typeof result !== "object" || !("type" in result)) {
    throw new Error(`Capability batch result ${index} is invalid.`);
  }
  const toolResult = result as PilotDeckToolResult;
  if (toolResult.toolCallId !== call.id) {
    throw new Error(`Capability batch result ${index} does not match tool call ${call.id}.`);
  }
  return toolResult;
}

function moduleFailureResult(call: PilotDeckToolCall, response: ModuleResponse): PilotDeckToolResult {
  return {
    type: "error",
    toolCallId: call.id,
    toolName: call.name,
    error: {
      code: asToolErrorCode(response.code),
      message: String(response.error?.message ?? "Capability module failed."),
      ...(response.code || response.error ? {
        details: {
          ...(response.code ? { moduleCode: response.code } : {}),
          ...(response.error ? { moduleError: response.error } : {}),
        },
      } : {}),
    },
    content: [{ type: "text", text: String(response.error?.message ?? "Capability module failed.") }],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
}

function serializeToolContext(context: PilotDeckToolRuntimeContext): Record<string, unknown> {
  return {
    sessionId: context.sessionId,
    turnId: context.turnId,
    cwd: context.cwd,
    permissionMode: context.permissionMode,
    permissionContext: context.permissionContext,
    runMode: context.runMode,
    currentToolCallId: context.currentToolCallId,
    maxResultBytes: context.maxResultBytes,
  };
}

function serializeExecutionContext(execution: { runId: string; turnId: string; operationId?: string; idempotencyKey?: string; operationDeadline?: string }): Record<string, unknown> {
  return {
    runId: execution.runId,
    turnId: execution.turnId,
    operationId: execution.operationId,
    idempotencyKey: execution.idempotencyKey,
    operationDeadline: execution.operationDeadline,
  };
}

export type SidecarExecution = {
  loop: AgentLoop;
  input: AgentLoopInput;
};

export type SidecarExecutionFactory = (input: {
  request: ModuleExecuteRequest;
  abortSignal: AbortSignal;
  abortExecution?: (reason?: unknown) => void;
  callModule: SidecarModuleCallClient;
}) => Promise<SidecarExecution> | SidecarExecution;

export type AgentLoopSidecarOptions = {
  moduleId?: string;
  moduleInstanceId?: string;
  capabilities?: ModuleCapabilities;
  uuid?: () => string;
};

/**
 * JSON-lines server for a host-owned AgentLoop.
 *
 * The server intentionally has no process, HTTP, or provider knowledge. A host
 * supplies an execution factory and handles model/capability calls on the same
 * bidirectional stream.
 */
export class AgentLoopSidecarServer {
  readonly moduleId: string;
  readonly moduleInstanceId: string;
  readonly connectionGeneration: string;
  private readonly uuid: () => string;
  private readonly pendingCalls = new Map<string, { resolve: (response: ModuleResponse) => void; reject: (error: unknown) => void }>();
  private readonly moduleFailures = new Map<string, { code?: string; message: string; retryability?: string }>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly activeExecutions = new Set<Promise<void>>();
  private writeChain = Promise.resolve();

  constructor(
    private readonly factory: SidecarExecutionFactory,
    private readonly options: AgentLoopSidecarOptions = {},
  ) {
    this.uuid = options.uuid ?? (() => Math.random().toString(36).slice(2));
    this.moduleId = options.moduleId ?? "pilotdeck-agent-loop";
    this.moduleInstanceId = options.moduleInstanceId ?? `${this.moduleId}-instance`;
    this.connectionGeneration = `${this.moduleInstanceId}-${this.uuid()}`;
  }

  async serve(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        await this.send(output, {
          kind: "error",
          messageId: this.nextId("parse"),
          code: "INVALID_JSON",
          message: "Module message is not valid JSON.",
          retryability: "unsafe",
        });
        continue;
      }
      const validation = validateModuleMessage(value);
      if (!validation.ok) {
        await this.send(output, {
          kind: "error",
          messageId: this.nextId("validation"),
          code: validation.code,
          message: validation.message,
          retryability: "unsafe",
        });
        continue;
      }
      const message = value as ModuleMessage;
      if (message.kind === "response") {
        const resolve = this.pendingCalls.get(message.inReplyTo);
        if (resolve) {
          this.pendingCalls.delete(message.inReplyTo);
          resolve.resolve(message);
        }
        continue;
      }
      if (message.kind !== "request") continue;
      if (message.method === "hello") {
        await this.send(output, this.handshake(message.messageId, "hello"));
      } else if (message.method === "capabilities") {
        await this.send(output, {
          ...this.handshake(message.messageId, "capabilities"),
          payload: this.options.capabilities ?? defaultCapabilities(),
        });
      } else if (message.method === "execute") {
        const execution = this.handleExecute(message, output);
        this.activeExecutions.add(execution);
        void execution.finally(() => this.activeExecutions.delete(execution));
      } else if (message.method === "module_call") {
        // module_call is sidecar-originated; receiving one is a protocol error.
        await this.send(output, {
          kind: "response",
          messageId: this.nextId("module-call"),
          inReplyTo: message.messageId,
          requestId: message.requestId,
          ok: false,
          final: true,
          outcome: "failed",
          code: "UNEXPECTED_MODULE_CALL",
        });
      } else if (message.method === "cancel") {
        const controller = this.abortControllers.get(message.operationId);
        controller?.abort(message.reason);
        await this.send(output, {
          kind: "response",
          messageId: this.nextId("cancel"),
          inReplyTo: message.messageId,
          requestId: message.requestId,
          ok: true,
          payload: { operationId: message.operationId, cancelled: Boolean(controller) },
        });
      }
    }
    await Promise.all([...this.activeExecutions]);
  }

  private async handleExecute(request: ModuleExecuteRequest, output: Writable): Promise<void> {
    const controller = new AbortController();
    this.abortControllers.set(request.operationId, controller);
    let deadlineExceeded = false;
    const deadlineAt = earliestDeadline(request.operationDeadline, request.attemptDeadline);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (deadlineAt !== undefined) {
      const abortForDeadline = () => {
        deadlineExceeded = true;
        controller.abort({ code: "DEADLINE_EXCEEDED", message: "Module execution deadline exceeded." });
      };
      if (deadlineAt <= Date.now()) abortForDeadline();
      else deadlineTimer = setTimeout(abortForDeadline, Math.min(2_147_483_647, deadlineAt - Date.now()));
    }
    const streamId = this.nextId("stream");
    await this.send(output, {
      kind: "response",
      messageId: this.nextId("accepted"),
      inReplyTo: request.messageId,
      requestId: request.requestId,
      ok: true,
      streamId,
      cursor: 0,
    });
    let sequence = 0;
    let finalSent = false;
    try {
      const execution = await this.factory({
        request,
        abortSignal: controller.signal,
        abortExecution: (reason?: unknown) => controller.abort(reason),
        callModule: (call) => this.callModule(output, call, controller.signal),
      });
      const iterator = execution.loop.run(execution.input);
      let next = await iterator.next();
      while (!next.done) {
        const event = next.value;
        await this.send(output, {
          kind: "event",
          messageId: this.nextId("event"),
          eventType: `agent.${event.type}`,
          streamId,
          sequence: sequence++,
          runId: request.runId,
          operationId: request.operationId,
          requestId: request.requestId,
          final: false,
          payload: event as unknown as Record<string, unknown>,
        });
        next = await iterator.next();
      }
      const result = next.value;
      const outcome = deadlineExceeded
        ? "failed"
        : moduleOutcomeFromAgentResult(result.result);
      const moduleFailure = this.moduleFailures.get(request.operationId);
      const terminalError = deadlineExceeded
        ? { code: "DEADLINE_EXCEEDED", message: "Module execution deadline exceeded." }
        : result.result.type === "max_turns"
          ? result.result.errors?.[0] ?? {
              code: "agent_max_turns_reached",
              message: "AgentLoop maximum turn limit reached.",
            }
          : result.result.type === "error"
            ? result.result.errors?.[0]
            : moduleFailure;
      await this.send(output, {
        kind: "event",
        messageId: this.nextId("final"),
        eventType: `agent.execute.${outcome}`,
        streamId,
        sequence: sequence++,
        runId: request.runId,
        operationId: request.operationId,
        requestId: request.requestId,
        final: true,
        outcome,
        ...(terminalError ? { code: terminalError.code, error: terminalError } : {}),
        payload: { result: result.result, messages: result.messages },
      });
      finalSent = true;
    } catch (error) {
      const outcome = deadlineExceeded ? "failed" : controller.signal.aborted ? "cancelled" : "failed";
      const serialized = serializeExecutionError(error);
      await this.send(output, {
        kind: "event",
        messageId: this.nextId("failed"),
        eventType: `agent.execute.${outcome}`,
        streamId,
        sequence: sequence++,
        runId: request.runId,
        operationId: request.operationId,
        requestId: request.requestId,
        final: true,
        outcome,
        ...(serialized.code ? { code: serialized.code } : {}),
        error: serialized,
        payload: { error: serialized },
      });
      finalSent = true;
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (!finalSent) {
        await this.send(output, {
          kind: "event",
          messageId: this.nextId("unknown"),
          eventType: "agent.execute.unknown",
          streamId,
          sequence: sequence++,
          runId: request.runId,
          operationId: request.operationId,
          requestId: request.requestId,
          final: true,
          outcome: "result_unknown",
          payload: {},
        });
      }
      this.abortControllers.delete(request.operationId);
      this.moduleFailures.delete(request.operationId);
    }
  }

  private async callModule(output: Writable, call: SidecarModuleCall, abortSignal?: AbortSignal): Promise<ModuleResponse> {
    const messageId = this.nextId("module-call");
    const { recordFailure = true, ...wireCall } = call;
    const request: ModuleCallRequest = {
      kind: "request",
      messageId,
      method: "module_call",
      ...wireCall,
    };
    const response = new Promise<ModuleResponse>((resolve, reject) => {
      const entry = { resolve, reject };
      this.pendingCalls.set(messageId, entry);
      if (abortSignal?.aborted) {
        this.pendingCalls.delete(messageId);
        reject(new SidecarAbortError());
      } else {
        abortSignal?.addEventListener("abort", () => {
          if (this.pendingCalls.delete(messageId)) reject(new SidecarAbortError());
        }, { once: true });
      }
    });
    await this.send(output, request);
    const result = await response;
    if (!result.ok && recordFailure) {
      this.moduleFailures.set(call.operationId ?? "", {
        ...(result.code ? { code: result.code } : {}),
        message: String(result.error?.message ?? result.code ?? "Module call failed."),
      });
    }
    return result;
  }

  private handshake(inReplyTo: string, method: "hello" | "capabilities"): ModuleResponse {
    return {
      kind: "response",
      messageId: this.nextId(method),
      inReplyTo,
      ok: true,
      protocolVersion: MODULE_PROTOCOL_VERSION,
      moduleId: this.moduleId,
      moduleInstanceId: this.moduleInstanceId,
      connectionGeneration: this.connectionGeneration,
      capabilitiesVersion: (this.options.capabilities ?? defaultCapabilities()).capabilitiesVersion,
      payload: {},
    };
  }

  private async send(output: Writable, message: ModuleMessage | Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    this.writeChain = this.writeChain.then(() => new Promise<void>((resolve, reject) => {
      output.write(line, (error) => error ? reject(error) : resolve());
    }));
    return this.writeChain;
  }

  private nextId(prefix: string): string {
    return `${prefix}-${this.uuid()}`;
  }
}

function earliestDeadline(...values: Array<string | undefined>): number | undefined {
  const deadlines = values
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter((value) => Number.isFinite(value));
  return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}

function serializeExecutionError(error: unknown): Record<string, unknown> {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return {
      ...(typeof record.code === "string" ? { code: record.code } : {}),
      message: typeof record.message === "string" ? record.message : String(error),
      ...(Array.isArray(record.errors) ? { errors: record.errors } : {}),
    };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

class SidecarAbortError extends Error {
  constructor() {
    super("Sidecar module call aborted.");
    this.name = "SidecarAbortError";
  }
}

function asToolErrorCode(value: unknown): PilotDeckToolErrorCode {
  const codes: PilotDeckToolErrorCode[] = [
    "tool_not_found",
    "tool_unavailable",
    "invalid_tool_input",
    "permission_denied",
    "permission_cancelled",
    "permission_required",
    "tool_execution_failed",
    "tool_aborted",
    "tool_timeout",
    "result_too_large",
    "path_not_allowed",
    "file_not_found",
    "file_conflict",
    "unsupported_tool",
    "setup_required",
    "plan_mode_violation",
    "ask_mode_violation",
  ];
  return typeof value === "string" && codes.includes(value as PilotDeckToolErrorCode)
    ? value as PilotDeckToolErrorCode
    : "tool_execution_failed";
}

function defaultCapabilities(): ModuleCapabilities {
  return {
    capabilitiesVersion: "1",
    methods: [
      { name: "execute", enabled: true, profiles: ["streaming"], cancel: true, resumeSupport: "streaming", retry: "retry_after_status" },
      { name: "cancel", enabled: true },
      { name: "status", enabled: false },
      { name: "resume", enabled: false },
      { name: "ack", enabled: false },
    ],
  };
}

export function moduleOutcomeFromAgentResult(result: { type: string }): ModuleOutcome {
  return result.type === "aborted" ? "cancelled" : result.type === "success" ? "completed" : "failed";
}
