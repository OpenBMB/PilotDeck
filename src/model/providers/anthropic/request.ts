import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalToolResultContentBlock,
  CanonicalToolChoice,
  CanonicalToolSchema,
  ModelDefinition,
  ProviderConfig,
} from "../../protocol/canonical.js";
import { resolveThinkingPlan, throwIfUnsupportedThinkingPlan } from "../../thinking/registry.js";
import { messageContent } from "../../protocol/clone.js";
import { formatToolResultReferenceText } from "../toolResultReferenceText.js";
import { hasSpeedMapping, mapSpeedToAnthropicSpeed } from "../../request/speedMapping.js";

export type AnthropicRequestBody = {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | unknown[];
  tools?: AnthropicTool[];
  tool_choice?: Record<string, unknown>;
  temperature?: number;
  speed?: "fast";
  thinking?: {
    type: "enabled" | "adaptive";
    budget_tokens?: number;
  };
  output_config?: {
    effort?: string;
  };
  stream?: boolean;
  metadata?: Record<string, unknown>;
};

type AnthropicMessage = {
  role: "user" | "assistant";
  content: unknown[];
};

type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type: "ephemeral"; ttl: "5m" };
};

const ANTHROPIC_PROMPT_CACHE_TTL = "5m" as const;

function createPromptCacheControl(): { type: "ephemeral"; ttl: "5m" } {
  return { type: "ephemeral", ttl: ANTHROPIC_PROMPT_CACHE_TTL };
}
/**
 * Reserved tool name for Anthropic structured-output enforcement.
 * Exported so `extractStructuredOutput` and tests can recognize it.
 */
export const ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME = "__output__";

export function buildAnthropicRequest(
  request: CanonicalModelRequest,
  model: ModelDefinition,
  provider?: ProviderConfig,
): AnthropicRequestBody {
  const thinkingPlan = resolveThinkingPlan(request.thinking, provider ?? { id: "anthropic", protocol: "anthropic", url: "", apiKey: "", headers: {}, models: {} }, model);
  throwIfUnsupportedThinkingPlan(thinkingPlan, request);
  // A3: lower outputSchema → forced hidden tool. This goes BEFORE the
  // user-supplied tools so the dispatch order is stable, but Anthropic
  // does not actually care about ordering. We force `tool_choice` to point
  // at it unless `outputSchema.strict === false`.
  const baseTools = request.tools?.map(toAnthropicTool) ?? [];
  const outputTool = request.outputSchema
    ? toAnthropicStructuredOutputTool(request.outputSchema)
    : null;

  let toolChoice: Record<string, unknown> | undefined;
  if (outputTool && request.outputSchema?.strict !== false) {
    toolChoice = { type: "tool", name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME };
  } else {
    toolChoice = toAnthropicToolChoice(request.toolChoice);
  }

  const tools: AnthropicTool[] = outputTool ? [outputTool, ...baseTools] : baseTools;
  const cacheTools = request.cachePlan?.tools === true && tools.length > 0;
  if (cacheTools) {
    const lastTool = tools[tools.length - 1];
    if (lastTool) {
      tools[tools.length - 1] = { ...lastTool, cache_control: createPromptCacheControl() };
    }
  }

  // Anthropic allows at most 4 cache_control blocks per request. The default
  // PilotDeck layout uses system + recent3; an explicit tools marker consumes
  // one slot and therefore trims message breakpoints to two.
  const MAX_MESSAGE_BREAKPOINTS = cacheTools ? 2 : 3;
  const requestedBreakpoints = request.cachePlan?.messages ?? request.cacheBreakpoints;
  const trimmedBreakpoints = requestedBreakpoints
    ? requestedBreakpoints.length > MAX_MESSAGE_BREAKPOINTS
      ? requestedBreakpoints.slice(-MAX_MESSAGE_BREAKPOINTS)
      : requestedBreakpoints
    : null;
  const cacheBreakpoints = trimmedBreakpoints
    ? new Set(trimmedBreakpoints)
    : null;

  return {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? model.capabilities.maxOutputTokens,
    messages: request.messages.map((message, index) =>
      toAnthropicMessage(message, cacheBreakpoints?.has(index) ?? false),
    ),
    system: request.systemPrompt
      ? (request.cachePlan?.system === true
        || (request.cachePlan === undefined && request.cacheBreakpoints !== undefined))
        ? [{ type: "text", text: request.systemPrompt, cache_control: createPromptCacheControl() }]
        : request.systemPrompt
      : undefined,
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: toolChoice,
    temperature: request.temperature,
    speed: request.speed !== undefined && model.capabilities.supportsSpeed === true
      && hasSpeedMapping(provider?.speedMapping, "anthropic_speed")
      ? mapSpeedToAnthropicSpeed(request.speed)
      : undefined,
    thinking: thinkingPlan.enabled && thinkingPlan.thinkingType
      ? {
          type: thinkingPlan.thinkingType === "adaptive" ? "adaptive" : "enabled",
          ...(thinkingPlan.thinkingType === "enabled" && thinkingPlan.budgetTokens !== undefined
            ? { budget_tokens: thinkingPlan.budgetTokens }
            : {}),
        }
      : undefined,
    output_config: thinkingPlan.useAnthropicOutputEffort && thinkingPlan.effort
      ? { effort: thinkingPlan.effort }
      : undefined,
    stream: request.stream,
    metadata: toAnthropicMetadata(request.metadata),
  };
}

function toAnthropicStructuredOutputTool(
  schema: CanonicalModelRequest["outputSchema"] & object,
): AnthropicTool {
  return {
    name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
    description:
      schema.description ??
      `Return the final structured payload (schema name: ${schema.name}). Always call this tool exactly once.`,
    input_schema: schema.schema,
  };
}

function toAnthropicMessage(
  message: CanonicalMessage,
  markCacheBreakpoint: boolean,
): AnthropicMessage {
  const content = messageContent(message).map(toAnthropicContentBlock);

  // A4: attach `cache_control: { type: "ephemeral", ttl: "5m" }` to the
  // last cacheable content block. Anthropic thinking blocks cannot carry a
  // cache marker, so a thinking-only message is left unmarked.
  if (markCacheBreakpoint && content.length > 0) {
    for (let index = content.length - 1; index >= 0; index--) {
      const candidate = content[index];
      if (!candidate || typeof candidate !== "object" || (candidate as { type?: string }).type === "thinking") {
        continue;
      }
      content[index] = {
        ...(candidate as Record<string, unknown>),
        cache_control: createPromptCacheControl(),
      };
      break;
    }
  }

  return {
    role: message.role,
    content,
  };
}

function toAnthropicContentBlock(block: CanonicalContentBlock): unknown {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking": {
      const thinking: { type: "thinking"; thinking: string; signature?: string } = {
        type: "thinking",
        thinking: block.text,
      };
      if (block.signature) {
        thinking.signature = block.signature;
      }
      return thinking;
    }
    case "image":
      return block.source === "url"
        ? { type: "image", source: { type: "url", url: block.data } }
        : {
            type: "image",
            source: { type: "base64", media_type: block.mimeType, data: block.data },
          };
    case "pdf":
      return {
        type: "document",
        source: { type: "base64", media_type: block.mimeType, data: block.data },
      };
    case "audio":
      return block.source === "url"
        ? { type: "audio", source: { type: "url", url: block.data } }
        : {
            type: "audio",
            source: { type: "base64", media_type: block.mimeType, data: block.data },
          };
    case "video":
      return block.source === "url"
        ? { type: "video", source: { type: "url", url: block.data } }
        : {
            type: "video",
            source: { type: "base64", media_type: block.mimeType, data: block.data },
          };
    case "tool_call":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolCallId,
        content: block.content.map(toAnthropicToolResultContentBlock),
        is_error: block.isError,
      };
    case "tool_result_reference":
      return {
        type: "tool_result",
        tool_use_id: block.toolCallId,
        content: [{
          type: "text",
          text: formatToolResultReferenceText(block),
        }],
        is_error: block.isError,
      };
    case "media_reference":
      return { type: "text", text: block.preview };
  }
}

function toAnthropicToolResultContentBlock(block: CanonicalToolResultContentBlock): unknown {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return block.source === "url"
        ? { type: "image", source: { type: "url", url: block.data } }
        : {
            type: "image",
            source: { type: "base64", media_type: block.mimeType, data: block.data },
          };
    case "pdf":
      return {
        type: "document",
        source: { type: "base64", media_type: block.mimeType, data: block.data },
      };
  }
}

function toAnthropicTool(tool: CanonicalToolSchema): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

function toAnthropicMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!metadata || typeof metadata.user_id !== "string" || metadata.user_id.length === 0) {
    return undefined;
  }
  return { user_id: metadata.user_id };
}

function toAnthropicToolChoice(toolChoice: CanonicalToolChoice | undefined): Record<string, unknown> | undefined {
  if (!toolChoice) {
    return undefined;
  }

  if (toolChoice === "auto") {
    return { type: "auto" };
  }
  if (toolChoice === "none") {
    return { type: "none" };
  }
  if (toolChoice === "required") {
    return { type: "any" };
  }

  return { type: "tool", name: toolChoice.name };
}
