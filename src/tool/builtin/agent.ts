import { randomUUID } from "node:crypto";
import type { CanonicalModelRequest, CanonicalUsage } from "../../model/index.js";
import type { PermissionResult } from "../../permission/index.js";
import { SUBAGENT_DEFINITIONS } from "../../agent/sub/builtinSubagentTypes.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  PilotDeckSubagentForkApi,
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolModelClient,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";

/**
 * `agent` builtin tool — dispatches a subtask to a subagent.
 *
 * **Two execution modes**:
 *
 *   1. Full fork (C2 §6.2)  — when `context.subagent` is wired (i.e. the
 *      caller is the AgentLoop), we run a real subagent with its own
 *      `AgentLoop`, scoped tool registry, and 5-field structured report.
 *
 *   2. Single-shot legacy  — when `context.subagent` is absent (stand-alone
 *      tool runtime / unit tests), we fall back to one synchronous model
 *      call against the simple `BUILTIN_SUBAGENTS` presets so existing tests
 *      stay green.
 *
 * Mirrors the legacy upstream agent tool input schema (description / prompt /
 * subagent_type) and the 5-field
 * `Scope/Result/Key files/Files changed/Issues` output contract.
 */

export type AgentSubagentType =
  | "general-purpose"
  | "plan"
  | "explore"
  | "verify";

export type AgentSubagentDefinition = {
  type: AgentSubagentType;
  description: string;
  systemPrompt: string;
};

/** Legacy P0 single-shot presets. Used only in the fallback path. */
export const BUILTIN_SUBAGENTS: Record<string, AgentSubagentDefinition> = {
  "general-purpose": {
    type: "general-purpose",
    description:
      "General-purpose subagent for delegating bounded research / synthesis tasks. Returns a single text answer.",
    systemPrompt:
      "You are a general-purpose subagent inside PilotDeck. Read the user's instructions, reason carefully, and produce a single concise text answer. Do not ask follow-up questions; do your best with the information given.",
  },
  plan: {
    type: "plan",
    description:
      "Planning subagent. Given a task description, produce an actionable step-by-step plan without executing it.",
    systemPrompt:
      "You are a planning subagent inside PilotDeck. Given a task, return a numbered plan of concrete steps a developer or operator could follow. Be specific. Do not perform the steps yourself; return the plan only.",
  },
  verify: {
    type: "verify",
    description:
      "Verification subagent. Given a claim or proposed change, return a critique with specific concerns and recommended checks.",
    systemPrompt:
      "You are a verification subagent inside PilotDeck. Given a proposal, change, or claim, return a structured critique with: (1) specific concerns, (2) recommended checks, (3) overall verdict. Be rigorous; flag risks even if minor.",
  },
  explore: {
    type: "explore",
    description:
      "Exploration subagent. Given a topic or question, return an overview of approaches, trade-offs, and pointers.",
    systemPrompt:
      "You are an exploration subagent inside PilotDeck. Given a topic, return a structured overview: (a) common approaches, (b) trade-offs between them, (c) recommended next steps for someone unfamiliar with the area.",
  },
};

export type AgentToolInput = {
  description: string;
  prompt: string;
  subagent_type?: string;
  /** @deprecated camelCase alias retained for backwards compatibility. */
  subagentType?: string;
  /**
   * Optional task id returned as `task_id` by a previous agent call. When
   * present, the same child subagent continues with its prior durable
   * context and only the new `prompt` is appended.
   */
  task_id?: string;
};

export type AgentToolOutput = {
  subagentType: string;
  description: string;
  text: string;
  usage?: CanonicalUsage;
  turns?: number;
  durationMs?: number;
  parsed?: Record<string, string>;
  /**
   * Stable task id of the child (the subagent UUID). Pass it back as
   * `task_id` to continue this child with its prior context.
   */
  taskId?: string;
};

export type CreateAgentToolOptions = {
  /**
   * Override the model client for the *fallback* single-shot path. The full
   * fork path uses `context.subagent.fork(...)` and ignores this option.
   */
  model?: PilotDeckToolModelClient;
  /** Override which fallback subagent presets are available. */
  subagents?: Record<string, AgentSubagentDefinition>;
  provider?: string;
  model_?: string;
  maxOutputTokens?: number;
};

const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;
const DEFAULT_PROVIDER_FALLBACK = "pilotdeck";
const DEFAULT_MODEL_FALLBACK = "moonshotai/kimi-k2.6";
const DEFAULT_SUBAGENT_TIMEOUT_MS = 60 * 60_000;
const PUBLIC_SUBAGENT_TYPES = ["general-purpose", "explore", "plan"] as const;

/**
 * In-flight task_id continuations. Tool-scope (deliberately not agent
 * module) so the tool stays independent of agent internals. Guard is
 * acquired synchronously before the tool's first await and released in
 * `finally`, so simultaneous continuations of the same task fail fast
 * without any provider call.
 */
const activeTaskContinuations = new Set<string>();

function normalizeTaskId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", "task_id must be a string returned by an earlier agent call.");
  }
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(trimmed)) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", "task_id must be a non-empty task identifier returned by an earlier agent call.");
  }
  return trimmed;
}

function acquireContinuationGuard(taskId: string, key: string): void {
  if (activeTaskContinuations.has(key)) {
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `Subagent task ${taskId} is already being continued; simultaneous continuation of the same task is not supported.`,
      { errorCode: "subagent_task_busy" },
    );
  }
  activeTaskContinuations.add(key);
}

/**
 * Structural mapping for continuation failures raised by the runtime: any
 * error carrying a `subagent_task_*` code is surfaced with that code
 * preserved (keeps the tool layer free of agent-module imports).
 */
function mapContinuationError(error: unknown): PilotDeckToolRuntimeError | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !code.startsWith("subagent_task_")) return undefined;
  return new PilotDeckToolRuntimeError(
    code === "subagent_task_unsupported" ? "unsupported_tool" : "invalid_tool_input",
    error.message,
    { errorCode: code },
  );
}

export function createAgentTool(
  options: CreateAgentToolOptions = {},
): PilotDeckToolDefinition<AgentToolInput, AgentToolOutput> {
  const fallbackPresets = options.subagents ?? BUILTIN_SUBAGENTS;
  const description = buildAgentToolDescription();

  return {
    name: "agent",
    aliases: ["Agent", "Task"],
    description,
    kind: "agent",
    inputSchema: {
      type: "object",
      required: ["description", "prompt"],
      additionalProperties: false,
      properties: {
        description: {
          type: "string",
          description: "Short 3-5 word task summary used to label the subagent run.",
        },
        prompt: {
          type: "string",
          description:
            "Detailed directive for the subagent. Include the goal, relevant context, constraints, and desired output; do not assume the subagent already knows why the task matters.",
        },
        subagent_type: {
          type: "string",
          description:
            "Optional subagent preset. Public built-ins: 'general-purpose' (full tool access), 'explore' (read-only investigation with read_file/grep/glob/bash), or 'plan' (read-only planning with read_file/grep/glob). Some runtimes may also expose additional presets such as 'verify'. Defaults to 'general-purpose' when omitted. Legacy 'general_purpose' is still accepted for compatibility.",
        },
        subagentType: {
          type: "string",
          description: "Deprecated legacy alias for subagent_type. Prefer subagent_type.",
        },
        task_id: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description:
            "Optional task id returned as `task_id` by a previous agent call. When present, the same child subagent continues with its prior context: its earlier user/assistant/tool history is restored and only the new `prompt` is added. Omit `subagent_type` to reuse the task's saved identity, or pass the matching type (a conflicting type fails).",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    checkPermissions: async (): Promise<PermissionResult> => ({
      type: "allow",
      reason: {
        type: "tool",
        toolName: "agent",
        message: "Subagent invocation is allowed without prompting.",
      },
    }),
    execute: async (input, context) => {
      const explicit = normalizeRequestedSubagentType(
        input.subagent_type ?? input.subagentType,
      );
      const directive = input.prompt;
      const taskId = normalizeTaskId(input.task_id);

      // Full fork path (C2): preferred when AgentLoop wired the fork API.
      if (context.subagent) {
        if (taskId && !context.subagent.supportsContinuation) {
          throw new PilotDeckToolRuntimeError(
            "unsupported_tool",
            "This subagent runtime does not support task_id continuation. Start a new agent call instead.",
            { errorCode: "subagent_task_unsupported" },
          );
        }
        return runFullFork({
          input,
          context,
          explicit,
          taskId,
          directive,
          fork: context.subagent,
        });
      }

      // Legacy stand-alone runtime has no sidechain persistence; never
      // silently start a new child when the caller asked for a continuation.
      if (taskId) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "task_id continuation requires the full-fork subagent runtime; the legacy single-shot agent runtime does not support it. Start a new agent call instead.",
          { errorCode: "subagent_task_unsupported" },
        );
      }

      let requestedType = explicit ?? "general-purpose";
      if ((context.permissionContext?.mode === "plan" || context.runMode === "ask") && requestedType === "general-purpose") {
        requestedType = "explore";
      }

      return runFallback({
        input,
        context,
        requestedType,
        directive,
        presets: fallbackPresets,
        model: options.model,
        provider: options.provider ?? DEFAULT_PROVIDER_FALLBACK,
        modelId: options.model_ ?? DEFAULT_MODEL_FALLBACK,
        maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      });
    },
  };
}

function buildAgentToolDescription(): string {
  const publicTypes = PUBLIC_SUBAGENT_TYPES
    .map((id) => {
      const definition = SUBAGENT_DEFINITIONS[id];
      const tools =
        definition.allowedTools[0] === "*"
          ? "all parent tools except nested agent launch"
          : definition.allowedTools.join(", ");
      return `- ${id}: ${definition.description} Tools: ${tools}.`;
    })
    .join("\n");

  return [
    "Launch a new subagent to handle a focused multi-step task.",
    "",
    "Use this tool when a bounded piece of work would benefit from an autonomous helper instead of keeping every intermediate step in the parent agent's context.",
    "",
    "Provide:",
    "- `description`: a short 3-5 word label for the task.",
    "- `prompt`: the full directive for the subagent. Write it like a complete briefing: include the goal, relevant context, constraints, and what good output looks like.",
    "- `subagent_type` (optional): choose a built-in preset. If omitted, `general-purpose` is used.",
    "- `task_id` (optional): pass the `task_id` from an earlier agent result to CONTINUE that same child subagent with its prior context; only the new `prompt` is added. Omit `subagent_type` when continuing so the task's saved identity is reused.",
    "",
    "Available built-in subagent types:",
    publicTypes,
    "",
    "The subagent returns one structured report with these sections: `Scope`, `Result`, `Key files`, `Files changed`, and `Issues`. The result also carries a `task_id` you can pass back later to follow up with the same child.",
    "",
    "Runtime behavior:",
    "- Multiple independent agent calls in one assistant message may run concurrently; batch sibling investigations when their scopes do not depend on each other.",
    "- Inside the AgentLoop, this runs a real forked subagent with its own scoped tool loop.",
    "- A `task_id` continuation restores the child's prior user/assistant/tool history and reuses its identity, provider, and model; current permission mode and tool restrictions of the parent always apply.",
    "- In stand-alone runtimes and some tests, it falls back to a single model call that preserves the same high-level subagent intent.",
  ].join("\n");
}

const ASK_MODE_SUBAGENT_TYPES = ["explore", "plan", "verify"] as const;

export function buildAskModeAgentToolSchema(): {
  description: string;
  inputSchema: Record<string, unknown>;
} {
  const typeLines = ASK_MODE_SUBAGENT_TYPES
    .map((id) => {
      const definition = SUBAGENT_DEFINITIONS[id];
      return `- ${id}: ${definition.description} Tools: ${definition.allowedTools.join(", ")}.`;
    })
    .join("\n");

  const description = [
    "Launch a read-only subagent for investigation, planning, or verification.",
    "",
    "In ask mode, subagents inherit ask mode and the same permission setting. Only read-only subagent types are available; 'general-purpose' is treated as 'explore'.",
    "",
    "Provide:",
    "- `description`: a short 3-5 word label for the task.",
    "- `prompt`: the full directive for the subagent. Include goal, context, constraints, and what good output looks like. The subagent can only read and search; it cannot modify files.",
    "- `subagent_type` (optional): 'explore', 'plan', or 'verify'. Defaults to 'explore'.",
    "- `task_id` (optional): pass the `task_id` from an earlier agent result to continue that same child subagent with its prior context; only the new `prompt` is added. Omit `subagent_type` when continuing so the task's saved identity is reused.",
    "",
    "Available subagent types:",
    typeLines,
    "",
    "The subagent returns one structured report with these sections: `Scope`, `Result`, `Key files`, `Files changed`, and `Issues`. The result also carries a `task_id` you can pass back later to follow up with the same child.",
  ].join("\n");

  const inputSchema: Record<string, unknown> = {
    type: "object",
    required: ["description", "prompt"],
    additionalProperties: false,
    properties: {
      description: {
        type: "string",
        description: "Short 3-5 word task summary used to label the subagent run.",
      },
      prompt: {
        type: "string",
        description:
          "Detailed directive for the subagent. Include the goal, relevant context, constraints, and desired output. The subagent can only read and search; it cannot modify files.",
      },
      subagent_type: {
        type: "string",
        description:
          "Subagent preset. In ask mode only 'explore', 'plan', and 'verify' are available. Defaults to 'explore'.",
      },
      subagentType: {
        type: "string",
        description: "Deprecated legacy alias for subagent_type. Prefer subagent_type.",
      },
      task_id: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        description:
          "Optional task id returned as `task_id` by a previous agent call. When present, the same child subagent continues with its prior context and only the new `prompt` is added. Omit `subagent_type` to reuse the task's saved identity.",
      },
    },
  };

  return { description, inputSchema };
}

function normalizeRequestedSubagentType(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (
    normalized === "general-purpose" ||
    normalized === "general_purpose" ||
    normalized === "general purpose"
  ) {
    return "general-purpose";
  }
  if (normalized === "explore" || normalized === "explorer") {
    return "explore";
  }
  if (normalized === "plan" || normalized === "verify") {
    return normalized;
  }
  return trimmed;
}

async function runFullFork(args: {
  input: AgentToolInput;
  context: PilotDeckToolRuntimeContext;
  /** Explicitly requested subagent type, already normalized. */
  explicit: string | undefined;
  /** task id of a previous child — when set, continue it instead of forking. */
  taskId: string | undefined;
  directive: string;
  fork: PilotDeckSubagentForkApi;
}): Promise<PilotDeckToolExecutionOutput<AgentToolOutput>> {
  const { input, context, explicit, taskId, directive, fork } = args;
  const guardKey = taskId ? JSON.stringify([context.cwd, context.sessionId, taskId]) : undefined;

  // Busy guard: acquired synchronously BEFORE the first await so two
  // simultaneous continuations of the same task cannot interleave — the
  // loser fails with `subagent_task_busy` without any provider call.
  // Released in `finally` on every path (success, error, cancel).
  if (taskId && guardKey) {
    acquireContinuationGuard(taskId, guardKey);
  }
  try {
    let requestedType: string | undefined;
    if (taskId) {
      // Continuation: the saved task identity decides the definition unless
      // the caller explicitly names one; the runtime rejects conflicts.
      requestedType = explicit;
    } else {
      requestedType = explicit ?? "general-purpose";
      if ((context.permissionContext?.mode === "plan" || context.runMode === "ask") && requestedType === "general-purpose") {
        requestedType = "explore";
      }
      if (!fork.isAllowedDefinition(requestedType)) {
        const allowed = fork.listDefinitions().map((d) => d.id).join(", ");
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          `Unknown subagent_type "${requestedType}". Available: ${allowed}.`,
        );
      }
    }
    const currentDepth = context.subagentDepth ?? fork.depth ?? 0;
    if (currentDepth >= fork.maxSubagentDepth) {
      throw new PilotDeckToolRuntimeError(
        "tool_execution_failed",
        `subagent_depth_exceeded (depth=${currentDepth}, max=${fork.maxSubagentDepth}); nested fork rejected.`,
        { errorCode: "subagent_depth_exceeded" },
      );
    }
    const subagentId = randomUUID();
    const timeoutMs = context.subagentTimeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
    let report;
    try {
      report = await fork.fork({
        definitionId: requestedType,
        directive,
        subagentId,
        taskId,
        toolCallId: context.currentToolCallId,
        abortSignal: context.abortSignal,
        timeoutMs,
      });
    } catch (error) {
      const continuationError = mapContinuationError(error);
      if (continuationError) {
        throw continuationError;
      }
      if (context.abortSignal?.aborted) {
        throw new PilotDeckToolRuntimeError(
          "tool_aborted",
          "agent subagent aborted before completion.",
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new PilotDeckToolRuntimeError(
        "tool_execution_failed",
        `agent subagent failed: ${message}`,
        { errorCode: "subagent_execution_failed" },
      );
    }
    if (context.abortSignal?.aborted) {
      throw new PilotDeckToolRuntimeError(
        "tool_aborted",
        "agent subagent aborted before completion.",
      );
    }
    const usedTaskId = report.subagentId ?? taskId ?? subagentId;
    const resumableTaskId = fork.supportsContinuation ? usedTaskId : undefined;
    const effectiveType = report.definitionId ?? requestedType ?? "general-purpose";
    const output: AgentToolOutput = {
      subagentType: effectiveType,
      description: input.description,
      text: report.markdown,
      usage: report.usage,
      turns: report.turns,
      durationMs: report.durationMs,
      parsed: report.parsed,
      ...(resumableTaskId ? { taskId: resumableTaskId } : {}),
    };
    return {
      content: [
        {
          type: "text",
          text: `[${effectiveType}] ${input.description}${resumableTaskId ? `\ntask_id: ${resumableTaskId}` : ""}\n\n${report.markdown}`,
        },
        { type: "json", value: output },
      ],
      data: output,
      metadata: {
        subagent: effectiveType,
        subagentId: usedTaskId,
        ...(taskId ? { continuedTaskId: taskId } : {}),
        forkMode: taskId ? "full-continuation" : "full",
        turns: report.turns,
        durationMs: report.durationMs,
      },
    };
  } finally {
    if (guardKey) {
      activeTaskContinuations.delete(guardKey);
    }
  }
}

async function runFallback(args: {
  input: AgentToolInput;
  context: PilotDeckToolRuntimeContext;
  requestedType: string;
  directive: string;
  presets: Record<string, AgentSubagentDefinition>;
  model?: PilotDeckToolModelClient;
  provider: string;
  modelId: string;
  maxOutputTokens: number;
}): Promise<PilotDeckToolExecutionOutput<AgentToolOutput>> {
  const {
    input,
    context,
    requestedType,
    directive,
    presets,
    model: explicitModel,
    provider,
    modelId,
    maxOutputTokens,
  } = args;

  const preset = presets[requestedType];
  if (!preset) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      `Unknown subagent_type "${requestedType}". Available: ${Object.keys(
        presets,
      ).join(", ")}.`,
    );
  }
  const model = explicitModel ?? context.model;
  if (!model) {
    throw new PilotDeckToolRuntimeError(
      "unsupported_tool",
      "agent tool requires a model client. Configure dependencies.model on AgentRuntimeDependencies, pass createAgentTool({ model }), or wire context.subagent for full-fork mode.",
    );
  }
  const request: CanonicalModelRequest = {
    provider,
    model: modelId,
    messages: [{ role: "user", content: [{ type: "text", text: directive }] }],
    systemPrompt: preset.systemPrompt,
    maxOutputTokens,
    stream: true,
    metadata: { subagent: preset.type, description: input.description },
  };
  let text = "";
  let usage: CanonicalUsage | undefined;
  for await (const event of model.stream(request, context.abortSignal)) {
    if (context.abortSignal?.aborted) {
      throw new PilotDeckToolRuntimeError(
        "tool_aborted",
        "agent subagent aborted before completion.",
      );
    }
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "usage":
        usage = event.usage;
        break;
      case "error":
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          `agent subagent model error: ${event.error.message}`,
          { errorCode: event.error.code },
        );
      default:
        break;
    }
  }
  const trimmed = text.trim();
  const output: AgentToolOutput = {
    subagentType: requestedType,
    description: input.description,
    text: trimmed.length > 0 ? trimmed : "(empty subagent response)",
    usage,
  };
  return {
    content: [
      {
        type: "text",
        text: `[${requestedType}] ${input.description}\n\n${output.text}`,
      },
      { type: "json", value: output },
    ],
    data: output,
    metadata: {
      subagent: requestedType,
      forkMode: "fallback",
      provider,
      model: modelId,
      promptBytes: Buffer.byteLength(directive, "utf8"),
    },
  };
}
