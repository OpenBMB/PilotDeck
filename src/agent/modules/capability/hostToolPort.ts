import type {
  PilotDeckToolCall,
  PilotDeckToolDefinition,
  PilotDeckToolErrorCode,
  PilotDeckToolResult,
  PilotDeckToolRuntimeContext,
} from "../../../tool/index.js";
import { createToolErrorResult } from "../../../tool/index.js";
import type { PermissionDecisionPort } from "../../../permission/index.js";
import type {
  AgentExecutionContext,
  HostCapabilityModuleMethod,
  ModuleCallRequest,
  ModuleResponse,
  ToolAuthorizationPort,
  ToolPort,
} from "../protocol.js";

type CapabilityModuleCall = Omit<ModuleCallRequest, "kind" | "messageId" | "method"> & {
  idempotencyKey?: string;
  recordFailure?: boolean;
};

export type HostCapabilityModuleClient = (request: CapabilityModuleCall) => Promise<ModuleResponse>;

export type HostCapabilityToolPortOptions = {
  tools?: PilotDeckToolDefinition[];
  /** Decode an advertised host catalog. Required when `list_tools` is used. */
  deserializeTools?: (value: unknown) => PilotDeckToolDefinition[];
  /** Optional host-owned decision provider that gates capability side effects. */
  permission?: PermissionDecisionPort;
  /** Immutable execution identity supplied by a sidecar composition. */
  binding?: {
    runId: string;
    operationId: string;
    idempotencyKey?: string;
  };
  uuid?: () => string;
  methods?: readonly HostCapabilityModuleMethod[];
  onAbort?: (reason: string) => void;
};

/**
 * Compose permission authorization separately from capability execution.
 * The wrapped ToolPort remains responsible only for executing authorized
 * calls. Authorization never re-groups calls: this preserves an advertised
 * execute_batch boundary and leaves scheduling to the execution provider.
 */
export function createPermissionAwareToolPort(
  port: ToolPort,
  options: {
    tools?: PilotDeckToolDefinition[];
    permission?: PermissionDecisionPort;
    authorization?: ToolAuthorizationPort;
    /** Keep authorized calls in one raw batch when the provider advertises it. */
    preserveBatch?: boolean;
  } = {},
): ToolPort {
  if (!options.permission && !options.authorization) return port;
  const toolByName = (name: string) => port.list.call(port).find((tool) => tool.name === name);
  return {
    list: () => port.list.call(port),
    ...(port.refresh ? { refresh: () => port.refresh!.call(port) } : {}),
    async executeAll(calls, context, execution) {
      const authorize = async (call: PilotDeckToolCall): Promise<PilotDeckToolCall | PilotDeckToolResult> => {
        if (options.authorization) {
          const outcome = await options.authorization.authorize(call, context);
          return "call" in outcome ? outcome.call : outcome.result;
        }
        const tool = toolByName(call.name);
        if (!tool) return call;
        const decision = await options.permission!.decide(tool, call.input, context, call.id);
        if (decision.type !== "allow") return permissionDecisionResult(call, decision, context);
        return { ...call, input: decision.updatedInput ?? call.input };
      };
      const slots = new Array<PilotDeckToolResult | undefined>(calls.length);
      const executeGroup = async (
        group: Array<{ index: number; call: PilotDeckToolCall }>,
        parallelize: boolean,
      ): Promise<void> => {
        const authorizeEntry = async ({ index, call }: { index: number; call: PilotDeckToolCall }) => ({ index, outcome: await authorize(call) });
        const authorized = parallelize
          ? await Promise.all(group.map(authorizeEntry))
          : await group.reduce(async (previous, entry) => [...await previous, await authorizeEntry(entry)], Promise.resolve([] as Array<Awaited<ReturnType<typeof authorizeEntry>>>));
        const executable = authorized.flatMap(({ index, outcome }) => "type" in outcome ? [] : [{ index, call: outcome }]);
        for (const { index, outcome } of authorized) {
          if ("type" in outcome) slots[index] = outcome;
        }
        if (executable.length === 0) return;
        const results = await port.executeAll.call(port, executable.map(({ call }) => call), context, execution);
        if (results.length !== executable.length) throw new Error("Tool port returned an incomplete authorized result.");
        for (const [resultIndex, { index }] of executable.entries()) slots[index] = results[resultIndex];
      };
      if (options.preserveBatch) {
        await executeGroup(calls.map((call, index) => ({ index, call })), false);
      } else {
        const parallel: Array<{ index: number; call: PilotDeckToolCall }> = [];
        const sequential: Array<{ index: number; call: PilotDeckToolCall }> = [];
        calls.forEach((call, index) => {
          const tool = toolByName(call.name);
          (tool?.isConcurrencySafe(call.input) ? parallel : sequential).push({ index, call });
        });
        await executeGroup(parallel, true);
        await executeGroup(sequential, false);
      }
      return slots as PilotDeckToolResult[];
    },
  };
}

/** Build a permission policy port without coupling it to tool execution. */
export function createPermissionToolAuthorizationPort(
  options: {
    tools?: PilotDeckToolDefinition[];
    /** Resolve against a live catalog when the tool provider supports refresh. */
    findTool?: (name: string) => PilotDeckToolDefinition | undefined;
    permission: PermissionDecisionPort;
  },
): ToolAuthorizationPort {
  const toolsByName = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  return {
    async authorize(call, context) {
      const tool = options.findTool?.(call.name) ?? toolsByName.get(call.name);
      if (!tool) return { call };
      const decision = await options.permission.decide(tool, call.input, context, call.id);
      return decision.type === "allow"
        ? { call: { ...call, input: decision.updatedInput ?? call.input } }
        : { result: permissionDecisionResult(call, decision, context) };
    },
  };
}

/** ToolPort consumer backed by a host-owned capability module. */
export function createHostCapabilityToolPort(
  callModule: HostCapabilityModuleClient,
  options: HostCapabilityToolPortOptions = {},
): ToolPort {
  // Native callers may still supply a combined options bag. Keep that
  // compatibility path at the outer adapter; the raw host capability port
  // below has no permission dependency.
  if (options.permission) {
    const { permission, ...executionOptions } = options;
    return createPermissionAwareToolPort(
      createHostCapabilityToolPort(callModule, executionOptions),
      { tools: options.tools, authorization: createPermissionToolAuthorizationPort({ tools: options.tools, permission }) },
    );
  }
  const uuid = options.uuid ?? (() => Math.random().toString(36).slice(2));
  let tools = [...(options.tools ?? [])];
  return {
    list: () => tools,
    ...(options.methods?.includes("list_tools")
      ? {
          async refresh(): Promise<PilotDeckToolDefinition[]> {
            if (!options.deserializeTools) {
              throw new Error("Host advertised list_tools without a sidecar tool descriptor decoder.");
            }
            const response = await callModule({
              runId: options.binding?.runId ?? "sidecar-tool-catalog",
              operationId: options.binding?.operationId ?? "sidecar-tool-catalog",
              idempotencyKey: options.binding?.idempotencyKey,
              requestId: `tool-catalog-${uuid()}`,
              module: "capability",
              payload: { operation: "list_tools" },
            });
            if (!response.ok) {
              throw new Error(String(response.error?.message ?? response.code ?? "Host tool catalog refresh failed."));
            }
            tools = options.deserializeTools(response.payload?.tools);
            return tools;
          },
        }
      : {}),
    async executeAll(
      calls: PilotDeckToolCall[],
      context: PilotDeckToolRuntimeContext,
      execution: AgentExecutionContext,
    ): Promise<PilotDeckToolResult[]> {
      const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

      if (options.methods?.includes("execute_batch") && calls.length > 0) {
        const resultSlots = new Array<PilotDeckToolResult | undefined>(calls.length);
        const response = await callModule({
          runId: execution.runId,
          operationId: execution.operationId ?? options.binding?.operationId ?? execution.turnId,
          idempotencyKey: execution.idempotencyKey ?? options.binding?.idempotencyKey,
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
        if (isResultUnknownCapabilityResponse(response)) {
          throw resultUnknownCapabilityError(response);
        }
        if (!response.ok) {
          for (const [index, call] of calls.entries()) resultSlots[index] = moduleFailureResult(call, response);
          return resultSlots as PilotDeckToolResult[];
        }
        if (!Array.isArray(results) || results.length !== calls.length) {
          throw new Error("Capability batch response must contain one result for every tool call.");
        }
        for (const [index, call] of calls.entries()) {
          resultSlots[index] = validateBatchToolResult(results[index], call, index);
        }
        return resultSlots as PilotDeckToolResult[];
      }

      const resultSlots = new Array<PilotDeckToolResult | undefined>(calls.length);
      const concurrent: Array<{ index: number; call: PilotDeckToolCall }> = [];
      const sequential: Array<{ index: number; call: PilotDeckToolCall }> = [];
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index]!;
        const tool = toolsByName.get(call.name);
        if (tool?.isConcurrencySafe(call.input)) concurrent.push({ index, call });
        else sequential.push({ index, call });
      }

      const execute = async (call: PilotDeckToolCall): Promise<PilotDeckToolResult> => {
        if (execution.abortSignal?.aborted) throw new Error("Tool execution cancelled.");
        const response = await callModule({
          runId: execution.runId,
          operationId: execution.operationId ?? options.binding?.operationId ?? execution.turnId,
          idempotencyKey: execution.idempotencyKey ?? options.binding?.idempotencyKey,
          requestId: `tool-${uuid()}`,
          module: "capability",
          payload: {
            name: call.name,
            arguments: call.input,
            toolCallId: call.id,
            context: serializeToolContext(context),
            execution: serializeExecutionContext(execution),
          },
        });
        if (execution.abortSignal?.aborted) throw new Error("Tool execution cancelled.");

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
        if (isResultUnknownCapabilityResponse(response)) {
          throw resultUnknownCapabilityError(response);
        }
        if (response.ok && payload && typeof payload === "object" && "type" in payload) {
          return payload as unknown as PilotDeckToolResult;
        }
        return moduleFailureResult(call, response);
      };

      await Promise.all(concurrent.map(async ({ index, call }) => {
        resultSlots[index] = await execute(call);
      }));
      for (const { index, call } of sequential) resultSlots[index] = await execute(call);
      return resultSlots as PilotDeckToolResult[];
    },
  };
}

function isResultUnknownCapabilityResponse(response: ModuleResponse): boolean {
  return response.ok === false && response.outcome === "result_unknown";
}

function resultUnknownCapabilityError(response: ModuleResponse): Error & { code: "RESULT_UNKNOWN" } {
  return Object.assign(
    new Error(String(response.error?.message ?? "Host capability execution outcome is unknown.")),
    { code: "RESULT_UNKNOWN" as const },
  );
}

function permissionDecisionResult(
  call: PilotDeckToolCall,
  decision: Exclude<Awaited<ReturnType<PermissionDecisionPort["decide"]>>, { type: "allow" }>,
  context: PilotDeckToolRuntimeContext,
): PilotDeckToolResult {
  const code: PilotDeckToolErrorCode = decision.type === "deny"
    ? decision.reason.type === "runtime" && decision.reason.message.includes("prompt")
      ? "permission_required"
      : "permission_denied"
    : decision.type === "cancel"
      ? "permission_cancelled"
      : "permission_required";
  const message = decision.type === "ask"
    ? `Permission is required to run ${call.name}.`
    : decision.message;
  return createToolErrorResult({
    toolCallId: call.id,
    toolName: call.name,
    code,
    message,
    ...(decision.type === "ask" ? { details: { request: decision.request } } : {}),
    startedAt: (context.now?.() ?? new Date()).toISOString(),
    context,
  });
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
    ...(context.outputTruncated !== undefined ? { outputTruncated: context.outputTruncated } : {}),
  };
}

function serializeExecutionContext(execution: AgentExecutionContext): Record<string, unknown> {
  return {
    runId: execution.runId,
    turnId: execution.turnId,
    operationId: execution.operationId,
    idempotencyKey: execution.idempotencyKey,
    operationDeadline: execution.operationDeadline,
  };
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
