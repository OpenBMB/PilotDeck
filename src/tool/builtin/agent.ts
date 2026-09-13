import { randomUUID } from "node:crypto";
import type { CanonicalModelRequest, CanonicalUsage } from "../../model/index.js";
import type { PermissionResult } from "../../permission/index.js";
import { SUBAGENT_DEFINITIONS } from "../../agent/sub/builtinSubagentTypes.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { DeliveryContract, DeliveryResult } from '../../agent/sub/delivery/types.js';
import { validateDeliveryContract } from '../../agent/sub/delivery/checks.js';
import { deliveryConfig } from '../../agent/sub/delivery/config.js';
import { buildDeliveryPrompt } from '../../agent/sub/delivery/prompt.js';
import { runDelivery } from '../../agent/sub/delivery/run.js';
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
  delivery?: DeliveryContract;
  description: string;
  prompt: string;
  subagent_type?: string;
  /** @deprecated camelCase alias retained for backwards compatibility. */
  subagentType?: string;
};

export type AgentToolOutput = {
  delivery?: DeliveryResult;
  delivery_file?: string;
  subagentType: string;
  description: string;
  text: string;
  usage?: CanonicalUsage;
  turns?: number;
  durationMs?: number;
  parsed?: Record<string, string>;
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
  temperature?: number;
};

const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;
const DEFAULT_PROVIDER_FALLBACK = "pilotdeck";
const DEFAULT_MODEL_FALLBACK = "moonshotai/kimi-k2.6";
const DEFAULT_SUBAGENT_TIMEOUT_MS = 60 * 60_000;
const PUBLIC_SUBAGENT_TYPES = ["general-purpose", "explore", "plan"] as const;
const DELIVERY_INPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'Optional delivery expectations. Auto already checks supplied file declarations. Add a sparse schema for this task or review:true for one bounded model review. Omitted fields are skipped; no answer key is needed. Off bypasses delivery checks.',
  properties: {
    schema: { type: 'object', description: 'Optional incremental structure for the submitted report: type/properties/items/title/description/x-file only. All fields optional, extra fields allowed. Use x-file:true on a string to declare a file path. No required, const or answer ranges.' },
    review: { type: 'boolean', description: 'Request model review when result quality needs judgment, e.g. code, consequential calculations or a complex report. Leave omitted for simple tasks. Reviewer sees only bounded delivery content.' },
  },
} as const;

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
        delivery: DELIVERY_INPUT_SCHEMA,
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
      if ((context.subagent?.deliveryMode ?? context.subtaskDelivery?.mode) !== 'off') {
        try { validateDeliveryContract(input.delivery); }
        catch (error) { throw new PilotDeckToolRuntimeError('invalid_tool_input', error instanceof Error ? error.message : String(error)); }
      }
      const explicit = normalizeRequestedSubagentType(
        input.subagent_type ?? input.subagentType,
      );
      const directive = input.prompt;

      // Full fork path (C2): preferred when AgentLoop wired the fork API.
      if (context.subagent) {
        let requestedType = explicit ?? "general-purpose";
        if ((context.permissionContext?.mode === "plan" || context.runMode === "ask") && requestedType === "general-purpose") {
          requestedType = "explore";
        }
        return runFullFork({
          input,
          context,
          requestedType,
          directive,
          fork: context.subagent,
        });
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
        temperature: options.temperature ?? 0,
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
    "",
    "Available built-in subagent types:",
    publicTypes,
    "",
    "In Auto, the child receives an editable delivery example and returns a delivery_file plus actual check/review status. Use delivery.schema for incremental task expectations and delivery.review=true when semantic result review is worth its cost. Missing fields are skipped. In Off the original text-report flow applies.",
    "",
    "Runtime behavior:",
    "- Multiple independent agent calls in one assistant message may run concurrently; batch sibling investigations when their scopes do not depend on each other.",
    "- Inside the AgentLoop, this runs a real forked subagent with its own scoped tool loop.",
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
    "",
    "Available subagent types:",
    typeLines,
    "",
    "Auto records the result in delivery_file and checks supplied declarations. Optional delivery.schema adds task structure; delivery.review=true requests bounded model review. The host archives the report even for a read-only child. Off preserves the original text flow.",
  ].join("\n");

  const inputSchema: Record<string, unknown> = {
    type: "object",
    required: ["description", "prompt"],
    additionalProperties: false,
    properties: {
      delivery: DELIVERY_INPUT_SCHEMA,
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
  requestedType: string;
  directive: string;
  fork: PilotDeckSubagentForkApi;
}): Promise<PilotDeckToolExecutionOutput<AgentToolOutput>> {
  const { input, context, requestedType, directive, fork } = args;

  if (!fork.isAllowedDefinition(requestedType)) {
    const allowed = fork.listDefinitions().map((d) => d.id).join(", ");
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      `Unknown subagent_type "${requestedType}". Available: ${allowed}.`,
    );
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
      toolCallId: context.currentToolCallId,
      abortSignal: context.abortSignal,
      timeoutMs,
      delivery: input.delivery,
    });
  } catch (error) {
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
  const output: AgentToolOutput = {
    subagentType: requestedType,
    description: input.description,
    text: report.markdown,
    usage: report.usage,
    turns: report.turns,
    durationMs: report.durationMs,
    parsed: report.parsed,
    ...(report.delivery ? { delivery: report.delivery, delivery_file: report.delivery.deliveryFile } : {}),
  };
  return {
    content: [
      {
        type: "text",
        text: `[${requestedType}] ${input.description}\n\n${report.markdown}${report.delivery ? formatDelivery(report.delivery) : ''}`,
      },
      { type: "json", value: output },
    ],
    data: output,
    metadata: {
      subagent: requestedType,
      subagentId,
      forkMode: "full",
      turns: report.turns,
      durationMs: report.durationMs,
      ...(report.delivery ? { delivery: report.delivery, delivery_file: report.delivery.deliveryFile } : {}),
    },
  };
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
  temperature: number;
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
    temperature,
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
    systemPrompt: context.subtaskDelivery?.mode === 'off' ? preset.systemPrompt
      : `${preset.systemPrompt}\n\n${buildDeliveryPrompt({ prompt: context.subtaskDelivery?.prompt, schema: input.delivery?.schema })}`,
    maxOutputTokens,
    temperature,
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
  if (context.subtaskDelivery?.mode !== 'off') {
    const subagentId = randomUUID();
    const now = new Date().toISOString();
    const recorded = await runDelivery({
      cwd: context.cwd, subagentId, task: directive,
      config: { ...deliveryConfig(context.subtaskDelivery), maxRepairs: 0 },
      contract: validateDeliveryContract(input.delivery), initialMessages: request.messages,
      mainModel: { provider, model: modelId }, signal: context.abortSignal,
      execute: async () => ({
        messages: [...request.messages, { role: 'assistant' as const, content: [{ type: 'text' as const, text }] }],
        result: { type: 'success' as const, sessionId: context.sessionId, turnId: context.turnId,
          stopReason: 'completed' as const, usage: usage ?? {}, permissionDenials: [], turns: 1, startedAt: now, completedAt: now },
      }),
    });
    output.delivery = recorded.delivery;
    output.delivery_file = recorded.delivery.deliveryFile;
  }
  return {
    content: [
      {
        type: "text",
        text: `[${requestedType}] ${input.description}\n\n${output.text}${output.delivery ? formatDelivery(output.delivery) : ''}`,
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
      ...(output.delivery ? { delivery: output.delivery, delivery_file: output.delivery.deliveryFile, repairSupported: false } : {}),
    },
  };
}

function formatDelivery(result: DeliveryResult): string {
  const last = result.attempts.at(-1);
  const issues = [...(last?.checks.issues ?? []), ...(last?.review?.issues ?? [])];
  return `\n\nDelivery file: ${result.deliveryFile}\nDeclared-field checks: ${last?.checks.status ?? 'skipped'}; model review: ${last?.review?.status ?? 'not requested'}; repairs: ${result.repairs}.`
    + (issues.length ? `\n${issues.slice(0, 8).map(issue => `${issue.path}: ${issue.message}`).join('\n')}` : '')
    + '\nRead delivery_file for full results; skipped checks are not evidence of completion.';
}
