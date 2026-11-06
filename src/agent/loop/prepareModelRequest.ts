import {
  cloneMessages,
  materializeMediaReferences,
  messageContent,
  type CanonicalMessage,
  type CanonicalModelRequest,
  type CanonicalToolSchema,
  type ModelProtocol,
} from "../../model/index.js";
import type { AgentContextRuntime } from "../../context/ContextRuntime.js";
import { NullContextRuntime } from "../../context/NullContextRuntime.js";
import { buildCachePlan } from "../../context/cache/CachePlan.js";
import type { PilotDeckToolDefinition, ToolRegistry } from "../../tool/index.js";
import { requiresPromptCapability } from "../../tool/userInteractionConstraints.js";
import { ASK_MODE_DESCRIPTION_SUFFIX, isAskModeAllowedTool } from "../../tool/askModeConstraints.js";
import { buildAskModeAgentToolSchema } from "../../tool/builtin/agent.js";
import type { AgentModelOverride } from "../protocol/input.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";

export type ModelRequestConfig = Pick<AgentRuntimeConfig,
  "provider" | "model" | "cwd" | "permissionMode" | "permissionContext" | "runMode" | "maxContextMessages" |
  "systemPrompt" | "pythonRuntime" | "toolChoice" | "maxOutputTokens" | "thinking" | "metadata">;

export type ModelRequestPreparationInput = {
  sessionId: string;
  turnId: string;
  messages: CanonicalMessage[];
  canPrompt?: boolean;
  allowPlanModeTools?: boolean;
  modelOverride?: AgentModelOverride;
  abortSignal?: AbortSignal;
  previewOnly?: boolean;
};

export type ModelRequestPreparationDependencies = {
  toolRegistry: Pick<ToolRegistry, "list">;
  context?: Pick<AgentContextRuntime, "prepareForModel">;
  getModelProtocol?: (provider: string) => ModelProtocol | undefined;
  getModelSupportsPromptCache?: (provider: string, model: string) => boolean | undefined;
  getPromptAddendum?: () => string | undefined;
  getPlanDirectoryPath?: () => string | undefined;
  /** Omitted by silent budget previews; the caller owns lifecycle delivery. */
  onInstructionsLoaded?: (hasSystemPrompt: boolean) => void;
};

/** Assemble one request from current capabilities; routing and recovery stay in AgentLoop. */
export async function prepareModelRequest(
  config: ModelRequestConfig,
  dependencies: ModelRequestPreparationDependencies,
  input: ModelRequestPreparationInput,
): Promise<CanonicalModelRequest> {
  const contextRuntime = dependencies.context ?? new NullContextRuntime();
  const canPrompt = input.canPrompt ?? config.permissionContext.canPrompt;
  let toolDefinitions = dependencies.toolRegistry.list();
  if (!canPrompt) toolDefinitions = toolDefinitions.filter((tool) => !requiresPromptCapability(tool, {}));
  if (input.allowPlanModeTools !== true) {
    toolDefinitions = toolDefinitions.filter(
      (tool) => tool.name !== "enter_plan_mode" && tool.name !== "exit_plan_mode",
    );
  }
  const requestMessages = normalizeMessagesForModelRequest(input.messages);
  const tools = config.runMode === "ask" ? filterAskModeTools(toolDefinitions) : toolDefinitions.map(toolToCanonicalSchema);
  const requestProvider = input.modelOverride?.provider ?? config.provider;
  const requestModel = input.modelOverride?.model ?? config.model;
  const prepared = await contextRuntime.prepareForModel({
    previewOnly: input.previewOnly,
    sessionId: input.sessionId,
    turnId: input.turnId,
    cwd: config.cwd,
    provider: requestProvider,
    model: requestModel,
    protocol: dependencies.getModelProtocol?.(requestProvider),
    supportsPromptCache: dependencies.getModelSupportsPromptCache?.(requestProvider, requestModel),
    permissionMode: config.permissionMode,
    runMode: config.runMode ?? "agent",
    additionalWorkingDirectories: config.permissionContext.additionalWorkingDirectories,
    messages: cloneMessages(requestMessages),
    tools,
    maxMessages: config.maxContextMessages,
    customSystemPrompt: config.systemPrompt,
    appendSystemPrompt: dependencies.getPromptAddendum?.(),
    pythonRuntime: config.pythonRuntime,
    abortSignal: input.abortSignal,
  });

  const systemPrompt = prepared.systemPrompt ?? config.systemPrompt;
  dependencies.onInstructionsLoaded?.(!!systemPrompt);

  const materialized = await materializeMediaReferences(prepared.messages);
  for (const diagnostic of materialized.diagnostics) {
    // eslint-disable-next-line no-console
    console.warn(
      `[pilotdeck] ${diagnostic.code}: ${diagnostic.message} (${diagnostic.mediaType}, ${diagnostic.path})`,
    );
  }

  const finalMessages = config.permissionMode === "plan"
    ? appendPlanModeReminder(materialized.messages, dependencies.getPlanDirectoryPath?.())
    : materialized.messages;
  const finalCachePlan = prepared.cachePlan
    ? buildCachePlan({
        provider: requestProvider,
        model: requestModel,
        systemPrompt,
        tools: prepared.tools,
        messages: finalMessages,
        enabled: true,
      }, prepared.cachePlan.generation)
    : undefined;
  const finalCacheBreakpoints = finalCachePlan?.messages ?? (
    config.permissionMode === "plan" ? undefined : prepared.cacheBreakpoints
  );

  return {
    provider: requestProvider,
    model: requestModel,
    messages: finalMessages,
    systemPrompt,
    tools: prepared.tools,
    toolChoice: config.toolChoice,
    maxOutputTokens: config.maxOutputTokens,
    speed: input.modelOverride?.speed,
    thinking: input.modelOverride?.thinking ?? config.thinking,
    stream: true,
    metadata: config.metadata,
    cacheBreakpoints: finalCacheBreakpoints,
    cachePlan: finalCachePlan,
  };
}

function planModeReminderMessage(planDirectory?: string): string {
  return [
    "Plan mode is active.",
    planDirectory
      ? `Read first using read-only tools, then use write_file/edit_file to write plan markdown ONLY under this absolute plan directory: ${planDirectory}`
      : "Read first using read-only tools, then write or refine plan markdown only under `.pilotdeck/plans/`.",
    ...(planDirectory ? ["Use that absolute directory for file paths and exit_plan_mode; do not assume cwd/.pilotdeck/plans is the plan directory."] : []),
    "Do not make implementation changes while planning.",
    "When the plan is ready for user review, call `exit_plan_mode` with the plan file path.",
  ].join("\n");
}

function filterAskModeTools(tools: PilotDeckToolDefinition[]): CanonicalToolSchema[] {
  const agentOverride = buildAskModeAgentToolSchema();
  return tools
    .filter(isAskModeAllowedTool)
    .map((tool) => {
      if (tool.name === "agent") {
        return { ...toolToCanonicalSchema(tool), description: agentOverride.description, inputSchema: agentOverride.inputSchema };
      }
      const suffix = ASK_MODE_DESCRIPTION_SUFFIX[tool.name];
      const schema = toolToCanonicalSchema(tool);
      return suffix ? { ...schema, description: schema.description + suffix } : schema;
    });
}

function toolToCanonicalSchema(tool: PilotDeckToolDefinition): CanonicalToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function appendPlanModeReminder(messages: CanonicalMessage[], planDirectory?: string): CanonicalMessage[] {
  return [
    ...messages,
    {
      role: "user",
      content: [{ type: "text", text: planModeReminderMessage(planDirectory) }],
      metadata: { synthetic: true, purpose: "plan_mode_reminder" },
    },
  ];
}

function normalizeMessagesForModelRequest(messages: CanonicalMessage[]): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  for (const rawMessage of messages) {
    const message: CanonicalMessage = {
      ...rawMessage,
      content: messageContent(rawMessage),
    };
    const last = out[out.length - 1];
    if (
      last?.role === "assistant" &&
      message.role === "assistant" &&
      canMergeAssistantMessages(last, message)
    ) {
      out[out.length - 1] = {
        role: "assistant",
        content: [...messageContent(last), ...messageContent(message)],
        metadata: mergeMessageMetadata(last.metadata, message.metadata),
      };
      continue;
    }
    if (message.role === "assistant" && message.content.length === 0) {
      continue;
    }
    out.push(message);
  }
  return out;
}

function canMergeAssistantMessages(first: CanonicalMessage, second: CanonicalMessage): boolean {
  return !hasToolCallBlock(first) && !hasToolCallBlock(second);
}

function hasToolCallBlock(message: CanonicalMessage): boolean {
  return messageContent(message).some((block) => block.type === "tool_call");
}

function mergeMessageMetadata(
  first: CanonicalMessage["metadata"],
  second: CanonicalMessage["metadata"],
): CanonicalMessage["metadata"] {
  if (!first && !second) {
    return undefined;
  }
  return {
    ...(first ?? {}),
    ...(second ?? {}),
  };
}
