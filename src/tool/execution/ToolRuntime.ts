import { isAbsolute, relative, resolve } from "node:path";
import { PermissionRuntime } from "../../permission/index.js";
import type { LifecycleRuntime, PilotDeckHookEffect } from "../../lifecycle/index.js";
import { toolError } from "../protocol/errors.js";
import type { PilotDeckToolErrorCode } from "../protocol/errors.js";
import {
  PLAN_MODE_ALLOWED_TOOLS,
  buildPlanModeBashViolationMessage,
  buildPlanModeViolationMessage,
} from "../planModeConstraints.js";
import { getAskModeViolation } from "../askModeConstraints.js";
import { isReadOnlyShellCommand } from "../builtin/bash/permissions.js";
import {
  applyResultSizeLimit,
  type PilotDeckToolErrorResult,
  type PilotDeckToolResult,
  type PilotDeckToolSuccessResult,
} from "../protocol/result.js";
import type { PilotDeckToolCall, PilotDeckToolRuntimeContext } from "../protocol/types.js";
import type { ToolRegistry } from "../registry/ToolRegistry.js";
import { validateToolInput } from "./validateToolInput.js";
import { formatValidationError } from "./formatValidationError.js";
import { normalizeToolError } from "../protocol/errors.js";
import type { AgentEventEmitter } from "../../agent/protocol/events.js";
import { requiresPromptCapability } from "../userInteractionConstraints.js";
import { buildToolErrorRecovery } from "./errorRecovery.js";
import { repairToolName } from "./repairToolName.js";

export class ToolRuntime {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissionRuntime: PermissionRuntime,
    private readonly lifecycle?: LifecycleRuntime,
    private readonly eventEmitter?: AgentEventEmitter,
  ) {}

  async execute(call: PilotDeckToolCall, context: PilotDeckToolRuntimeContext): Promise<PilotDeckToolResult> {
    const startedAtDate = now(context);
    const runtimeContext: PilotDeckToolRuntimeContext = context.executeTool
      ? context
      : {
          ...context,
          executeTool: (nestedCall, contextPatch) =>
            {
              runtimeContext.readFileState ??= new Map();
              runtimeContext.writeSnapshots ??= new Map();
              return this.execute(nestedCall, {
                ...runtimeContext,
                ...contextPatch,
                readFileState: runtimeContext.readFileState,
                writeSnapshots: runtimeContext.writeSnapshots,
                executeTool: runtimeContext.executeTool,
              });
            },
        };
    context = runtimeContext;
    const startedAt = startedAtDate.toISOString();
    let tool = this.registry.get(call.name);
    if (!tool) {
      const repaired = repairToolName(call.name, this.registry.list(), context.toolAliases);
      if (repaired) {
        tool = this.registry.get(repaired.name);
      }
    }
    const toolName = tool?.name ?? call.name;

    if (runtimeContext.abortSignal?.aborted) {
      return this.errorResult(call.id, toolName, "tool_aborted", "Tool execution was aborted.", startedAt, runtimeContext);
    }

    if (!tool) {
      return this.errorResult(
        call.id,
        call.name,
        "tool_not_found",
        `Tool ${call.name} does not exist.`,
        startedAt,
        runtimeContext,
      );
    }

    const planModeViolation = getPlanModeViolation(tool.name, call.input, runtimeContext);
    if (planModeViolation) {
      return this.errorResult(
        call.id,
        tool.name,
        "plan_mode_violation",
        planModeViolation,
        startedAt,
        runtimeContext,
      );
    }

    const askModeViolation = runtimeContext.runMode === "ask"
      ? getAskModeViolation(tool, call.input)
      : undefined;
    if (askModeViolation) {
      return this.errorResult(
        call.id,
        tool.name,
        "ask_mode_violation",
        askModeViolation,
        startedAt,
        runtimeContext,
      );
    }

    const validation = validateToolInput(call.input, tool.inputSchema);
    if (!validation.ok) {
      return this.errorResult(
        call.id,
        tool.name,
        "invalid_tool_input",
        formatValidationError(tool.name, validation.issues, {
          maxOutputTokens: runtimeContext.maxOutputTokens,
          outputTruncated: runtimeContext.outputTruncated,
        }),
        startedAt,
        runtimeContext,
        { issues: validation.issues },
      );
    }

    if (runtimeContext.permissionContext.canPrompt === false && requiresPromptCapability(tool, call.input)) {
      return this.errorResult(
        call.id,
        tool.name,
        "unsupported_tool",
        `${tool.name} requires user interaction, but this session is running with prompts disabled.`,
        startedAt,
        runtimeContext,
      );
    }

    let executeInput = call.input;
    const preToolResult = await this.dispatchLifecycle("PreToolUse", tool.name, call.id, executeInput, context);
    this.eventEmitter?.({ type: "pre_tool_execute", sessionId: context.sessionId, turnId: context.turnId, toolCallId: call.id, toolName: tool.name });
    const preBlock = findEffect(preToolResult.effects, "block");
    const prePermission = findEffect(preToolResult.effects, "permission_decision");
    const preDeny = prePermission?.behavior === "deny" ? prePermission : undefined;
    if (preBlock || preDeny) {
      return this.errorResult(
        call.id,
        tool.name,
        "permission_denied",
        preBlock?.reason ?? preDeny?.reason ?? `PreToolUse hook denied ${tool.name}.`,
        startedAt,
        context,
      );
    }
    const updatedInput = findEffect(preToolResult.effects, "updated_tool_input");
    if (updatedInput) {
      executeInput = updatedInput.input;
      const updatedValidation = validateToolInput(executeInput, tool.inputSchema);
      if (!updatedValidation.ok) {
        return this.errorResult(
          call.id,
          tool.name,
          "invalid_tool_input",
          `PreToolUse hook produced invalid input for ${tool.name}.

${formatValidationError(tool.name, updatedValidation.issues, {
            maxOutputTokens: runtimeContext.maxOutputTokens,
            outputTruncated: runtimeContext.outputTruncated,
          })}`,
          startedAt,
          context,
          { issues: updatedValidation.issues },
        );
      }
    }

    const toolValidation = await tool.validateInput?.(executeInput, context);
    if (toolValidation && !toolValidation.ok) {
      return this.errorResult(
        call.id,
        tool.name,
        "invalid_tool_input",
        formatValidationError(tool.name, toolValidation.issues, {
          maxOutputTokens: runtimeContext.maxOutputTokens,
          outputTruncated: runtimeContext.outputTruncated,
        }),
        startedAt,
        context,
        { issues: toolValidation.issues },
      );
    }

    const todoGateMessage = context.planTodo?.blockingMessageFor(
      tool.name,
      tool.isReadOnly(executeInput),
    );
    if (todoGateMessage) {
      return this.errorResult(
        call.id,
        tool.name,
        "tool_execution_failed",
        todoGateMessage,
        startedAt,
        context,
      );
    }

    let decision = await this.permissionRuntime.decide(tool, executeInput, context, call.id);
    if (decision.type === "ask") {
      const permissionHookResult = await this.dispatchLifecycle("PermissionRequest", tool.name, call.id, executeInput, context, {
        permissionSuggestions: decision.request.options,
      });
      this.eventEmitter?.({ type: "permission_requested", sessionId: context.sessionId, turnId: context.turnId, toolCallId: call.id, toolName: tool.name });
      const permissionRequestResult = findEffect(permissionHookResult.effects, "permission_request_result");
      if (permissionRequestResult?.result.behavior === "allow") {
        decision = {
          type: "allow",
          reason: { type: "runtime", message: `PermissionRequest hook allowed ${tool.name}.` },
          updatedInput: permissionRequestResult.result.updatedInput,
        };
      } else if (permissionRequestResult?.result.behavior === "deny") {
        decision = {
          type: "deny",
          reason: { type: "runtime", message: permissionRequestResult.result.message ?? `PermissionRequest hook denied ${tool.name}.` },
          message: permissionRequestResult.result.message ?? `PermissionRequest hook denied ${tool.name}.`,
        };
      }
    }
    await context.auditRecorder?.recordPermission({
      type: "permission",
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: call.id,
      toolName: tool.name,
      mode: context.permissionContext.mode,
      decision: decision.type,
      reason: decision.reason,
      createdAt: now(context).toISOString(),
    });

    if (decision.type === "deny") {
      await this.dispatchLifecycle("PermissionDenied", tool.name, call.id, executeInput, context, {
        reason: decision.message,
      });
      this.eventEmitter?.({ type: "permission_denied", sessionId: context.sessionId, turnId: context.turnId, toolName: tool.name, reason: decision.message });
      const code: PilotDeckToolErrorCode =
        decision.reason.type === "runtime" && decision.reason.message.includes("prompt") ?
          "permission_required" :
          "permission_denied";
      return this.errorResult(call.id, tool.name, code, decision.message, startedAt, context);
    }

    if (decision.type === "cancel") {
      return this.errorResult(call.id, tool.name, "permission_cancelled", decision.message, startedAt, context);
    }

    if (decision.type === "ask") {
      return this.errorResult(
        call.id,
        tool.name,
        "permission_required",
        `Permission is required to run ${tool.name}.`,
        startedAt,
        context,
        { request: decision.request },
      );
    }

    executeInput = decision.updatedInput ?? executeInput;
    const baseContext: PilotDeckToolRuntimeContext = {
      ...context,
      currentToolCallId: call.id,
      currentPermissionDecision: decision,
    };
    const executeContext: PilotDeckToolRuntimeContext = baseContext.progress
      ? {
          ...baseContext,
          progress: (event) =>
            baseContext.progress!({
              ...event,
              toolCallId: event.toolCallId || call.id,
              toolName: event.toolName || tool.name,
            }),
        }
      : baseContext;
    try {
      const output = await tool.execute(executeInput, executeContext);
      const maxResultBytes = tool.maxResultBytes ?? context.maxResultBytes;
      const previewLimit = applyResultSizeLimit(output.content, maxResultBytes);
      const completedAt = now(context).toISOString();
      const postToolLifecycle = await this.dispatchLifecycle(
        "PostToolUse",
        tool.name,
        call.id,
        executeInput,
        context,
        { toolResponse: output.data ?? output.content },
      );
      this.eventEmitter?.({ type: "post_tool_execute", sessionId: context.sessionId, turnId: context.turnId, toolCallId: call.id, toolName: tool.name, success: true });
      const result: PilotDeckToolSuccessResult = {
        type: "success",
        toolCallId: call.id,
        toolName: tool.name,
        content: output.content,
        supplementalMessages: output.supplementalMessages,
        data: output.data,
        metadata: mergeMetadata(
          output.metadata,
          mergeMetadata(
            previewLimit.metadata ? { previewLimit: previewLimit.metadata } : undefined,
            lifecycleMetadata(postToolLifecycle),
          ),
        ),
        startedAt,
        completedAt,
      };
      if (!tool.isReadOnly(executeInput) && tool.name !== "todo_write") {
        context.planTodo?.markToolProgressChanged(tool.name);
      }
      await this.recordToolAudit(result, context, startedAtDate);
      return result;
    } catch (error) {
      const normalized = normalizeToolError(error);
      await this.dispatchLifecycle("PostToolUseFailure", tool.name, call.id, executeInput, context, {
        error: normalized.message,
        isInterrupt: normalized.code === "tool_aborted",
      });
      this.eventEmitter?.({ type: "post_tool_execute", sessionId: context.sessionId, turnId: context.turnId, toolCallId: call.id, toolName: tool.name, success: false });
      const result = this.createErrorResult(call.id, tool.name, normalized.code, normalized.message, startedAt, context, normalized.details);
      await this.recordToolAudit(result, context, startedAtDate);
      return result;
    }
  }

  private async errorResult(
    toolCallId: string,
    toolName: string,
    code: PilotDeckToolErrorCode,
    message: string,
    startedAt: string,
    context: PilotDeckToolRuntimeContext,
    details?: Record<string, unknown>,
  ): Promise<PilotDeckToolErrorResult> {
    const startedAtDate = new Date(startedAt);
    const result = this.createErrorResult(toolCallId, toolName, code, message, startedAt, context, details);
    await this.recordToolAudit(result, context, startedAtDate);
    return result;
  }

  private createErrorResult(
    toolCallId: string,
    toolName: string,
    code: PilotDeckToolErrorCode,
    message: string,
    startedAt: string,
    context: PilotDeckToolRuntimeContext,
    details?: Record<string, unknown>,
  ): PilotDeckToolErrorResult {
    const completedAt = now(context).toISOString();
    const recovery = buildToolErrorRecovery({
      code,
      toolName,
      message,
      cwd: context.cwd,
      permissionMode: context.permissionMode,
      details,
    });
    return {
      type: "error",
      toolCallId,
      toolName,
      error: toolError(code, message, details),
      content: [{ type: "text", text: formatToolErrorContent(recovery.message, details) }],
      metadata: {
        recovery: recovery.advice,
      },
      startedAt,
      completedAt,
    };
  }

  private async recordToolAudit(
    result: PilotDeckToolResult,
    context: PilotDeckToolRuntimeContext,
    startedAt: Date,
  ): Promise<void> {
    await context.auditRecorder?.recordTool({
      type: "tool",
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      status: result.type === "success" ? "success" : "error",
      errorCode: result.type === "error" ? result.error.code : undefined,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      durationMs: new Date(result.completedAt).getTime() - startedAt.getTime(),
    });
  }

  private async dispatchLifecycle(
    event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PermissionRequest" | "PermissionDenied",
    toolName: string,
    toolCallId: string,
    toolInput: unknown,
    context: PilotDeckToolRuntimeContext,
    extraPayload: Record<string, unknown> = {},
  ) {
    return this.lifecycle?.dispatch({
      event,
      baseInput: {
        sessionId: context.sessionId,
        transcriptPath: "",
        cwd: context.cwd,
        permissionMode: context.permissionMode,
      },
      matchQuery: toolName,
      payload: {
        toolName,
        toolInput,
        toolUseId: toolCallId,
        ...extraPayload,
      },
      signal: context.abortSignal,
      env: context.env,
    }) ?? {
      effects: [],
      messages: [],
      events: [],
      blockingErrors: [],
      nonBlockingErrors: [],
    };
  }
}

function formatToolErrorContent(
  recoveryMessage: string,
  details?: Record<string, unknown>,
): string {
  const rawDetails = formatRawToolErrorDetails(details);
  return rawDetails ? `${recoveryMessage}\n\n${rawDetails}` : recoveryMessage;
}

function formatRawToolErrorDetails(details?: Record<string, unknown>): string | undefined {
  if (!details) {
    return undefined;
  }

  const lines: string[] = [];
  const command = readStringDetail(details, "command");
  const exitCode = details.exitCode;
  const timedOut = details.timedOut;
  const durationMs = details.durationMs;

  if (command || exitCode !== undefined || timedOut !== undefined || durationMs !== undefined) {
    lines.push("Raw tool details:");
    if (command) lines.push(`- command: ${command}`);
    if (exitCode !== undefined) lines.push(`- exit_code: ${String(exitCode)}`);
    if (timedOut !== undefined) lines.push(`- timed_out: ${String(timedOut)}`);
    if (durationMs !== undefined) lines.push(`- duration_ms: ${String(durationMs)}`);
  }

  const diagnostic = readStringDetail(details, "diagnostic");
  if (diagnostic) {
    lines.push("", "Diagnostic:", diagnostic.trimEnd());
  }

  appendRawStream(lines, "stdout", readStringDetail(details, "stdout"));
  appendRawStream(lines, "stderr", readStringDetail(details, "stderr"));

  return lines.length > 0 ? lines.join("\n") : undefined;
}

function appendRawStream(lines: string[], label: "stdout" | "stderr", value: string | undefined): void {
  if (!value || value.length === 0) {
    return;
  }
  lines.push("", `${label}:`, value.trimEnd());
}

function readStringDetail(details: Record<string, unknown>, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" ? value : undefined;
}

function getPlanModeViolation(
  toolName: string,
  input: unknown,
  context: PilotDeckToolRuntimeContext,
): string | undefined {
  if (context.permissionMode !== "plan") {
    return undefined;
  }

  if (!PLAN_MODE_ALLOWED_TOOLS.has(toolName)) {
    return buildPlanModeViolationMessage(toolName);
  }

  if (toolName === "bash") {
    const command = readStringProperty(input, "command");
    if (!command || !isReadOnlyShellCommand(command)) {
      return buildPlanModeBashViolationMessage(command ?? "");
    }
    return undefined;
  }

  if (toolName === "write_file" || toolName === "edit_file") {
    const filePath = readStringProperty(input, "file_path") ?? readStringProperty(input, "filePath");
    if (!isPlanMarkdownPath(filePath, context)) {
      return buildPlanModeViolationMessage(toolName);
    }
  }

  return undefined;
}

function readStringProperty(input: unknown, key: string): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanMarkdownPath(filePath: string | undefined, context: PilotDeckToolRuntimeContext): boolean {
  if (!filePath || !context.planDirectory?.path) {
    return false;
  }
  const absolute = resolve(isAbsolute(filePath) ? filePath : resolve(context.cwd, filePath));
  if (!absolute.toLowerCase().endsWith(".md")) {
    return false;
  }
  const relativeToPlanDir = relative(context.planDirectory.path, absolute);
  return (
    relativeToPlanDir !== ""
    && !isAbsolute(relativeToPlanDir)
    && !relativeToPlanDir.startsWith("..")
    && !relativeToPlanDir.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  );
}

function findEffect<Type extends PilotDeckHookEffect["type"]>(
  effects: PilotDeckHookEffect[],
  type: Type,
): Extract<PilotDeckHookEffect, { type: Type }> | undefined {
  return effects.find((effect): effect is Extract<PilotDeckHookEffect, { type: Type }> => effect.type === type);
}

function lifecycleMetadata(result: { effects: PilotDeckHookEffect[] }): Record<string, unknown> | undefined {
  const blocking = result.effects.find((effect) => effect.type === "block");
  const additionalContext = result.effects.filter((effect) => effect.type === "additional_context");
  const updatedMcpOutput = result.effects.find((effect) => effect.type === "updated_mcp_tool_output");
  if (!blocking && additionalContext.length === 0 && !updatedMcpOutput) {
    return undefined;
  }
  return {
    lifecycle: {
      blocked: blocking ? { reason: blocking.reason, stopReason: blocking.stopReason } : undefined,
      additionalContext: additionalContext.map((effect) => effect.content),
      updatedMcpToolOutput: updatedMcpOutput?.output,
    },
  };
}

function now(context: PilotDeckToolRuntimeContext): Date {
  return context.now?.() ?? new Date();
}

function mergeMetadata(
  first: Record<string, unknown> | undefined,
  second: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!first && !second) {
    return undefined;
  }

  return {
    ...(first ?? {}),
    ...(second ?? {}),
  };
}
