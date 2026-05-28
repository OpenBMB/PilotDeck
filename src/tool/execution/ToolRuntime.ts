import { PermissionRuntime } from "../../permission/index.js";
import type { LifecycleRuntime, PilotDeckHookEffect } from "../../lifecycle/index.js";
import { toolError } from "../protocol/errors.js";
import type { PilotDeckToolErrorCode } from "../protocol/errors.js";
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

export class ToolRuntime {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissionRuntime: PermissionRuntime,
    private readonly lifecycle?: LifecycleRuntime,
    private readonly eventEmitter?: AgentEventEmitter,
  ) {}

  async execute(call: PilotDeckToolCall, context: PilotDeckToolRuntimeContext): Promise<PilotDeckToolResult> {
    const startedAtDate = now(context);
    const startedAt = startedAtDate.toISOString();
    const tool = this.registry.get(call.name);
    const toolName = tool?.name ?? call.name;

    if (context.abortSignal?.aborted) {
      return this.errorResult(call.id, toolName, "tool_aborted", "Tool execution was aborted.", startedAt, context);
    }

    if (!tool) {
      return this.errorResult(
        call.id,
        call.name,
        "tool_not_found",
        `Tool ${call.name} does not exist.`,
        startedAt,
        context,
      );
    }

    const validation = validateToolInput(call.input, tool.inputSchema);
    if (!validation.ok) {
      return this.errorResult(
        call.id,
        tool.name,
        "invalid_tool_input",
        formatValidationError(tool.name, validation.issues, {
          maxOutputTokens: context.maxOutputTokens,
          outputTruncated: context.outputTruncated,
        }),
        startedAt,
        context,
        { issues: validation.issues },
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
          `PreToolUse hook produced invalid input for ${tool.name}.`,
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
        `Tool ${tool.name} rejected the input.`,
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
    const executeContext: PilotDeckToolRuntimeContext = context.progress
      ? {
          ...context,
          progress: (event) =>
            context.progress!({
              ...event,
              toolCallId: event.toolCallId || call.id,
              toolName: event.toolName || tool.name,
            }),
        }
      : context;
    try {
      const output = await tool.execute(executeInput, executeContext);
      const maxResultBytes = tool.maxResultBytes ?? context.maxResultBytes;
      const limited = applyResultSizeLimit(output.content, maxResultBytes);
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
        content: limited.content,
        supplementalMessages: output.supplementalMessages,
        data: output.data,
        metadata: mergeMetadata(
          output.metadata,
          mergeMetadata(limited.metadata, lifecycleMetadata(postToolLifecycle)),
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
      const result = this.createErrorResult(call.id, tool.name, normalized.code, normalized.message, startedAt, context, {
        details: normalized.details,
      });
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
    return {
      type: "error",
      toolCallId,
      toolName,
      error: toolError(code, message, details),
      content: [{ type: "text", text: message }],
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
