import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalToolResultContentBlock,
  CanonicalToolChoice,
  CanonicalToolSchema,
  ModelDefinition,
} from "../../protocol/canonical.js";

export type AnthropicRequestBody = {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | unknown[];
  tools?: AnthropicTool[];
  tool_choice?: Record<string, unknown>;
  temperature?: number;
  thinking?: {
    type: "enabled";
    budget_tokens?: number;
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
};

/**
 * Reserved tool name for Anthropic structured-output enforcement.
 * Exported so `extractStructuredOutput` and tests can recognize it.
 */
export const ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME = "__output__";

export function buildAnthropicRequest(
  request: CanonicalModelRequest,
  model: ModelDefinition,
): AnthropicRequestBody {
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

  // Anthropic allows at most 4 cache_control blocks per request.
  // Reserve 1 for the system prompt; keep the 3 most recent message breakpoints.
  const MAX_MESSAGE_BREAKPOINTS = 3;
  const trimmedBreakpoints = request.cacheBreakpoints
    ? request.cacheBreakpoints.length > MAX_MESSAGE_BREAKPOINTS
      ? request.cacheBreakpoints.slice(-MAX_MESSAGE_BREAKPOINTS)
      : request.cacheBreakpoints
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
      ? cacheBreakpoints
        ? [{ type: "text", text: request.systemPrompt, cache_control: { type: "ephemeral" } }]
        : request.systemPrompt
      : undefined,
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: toolChoice,
    temperature: request.temperature,
    thinking:
      request.thinking?.enabled && model.capabilities.supportsThinking
        ? { type: "enabled", budget_tokens: request.thinking.budgetTokens }
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
  const content = message.content.map(toAnthropicContentBlock);

  // A4: attach `cache_control: { type: "ephemeral" }` to the LAST content
  // block of this message. Anthropic anchors the cache breakpoint at this
  // block, so the prefix up to and including it is cached. Caller
  // (`CachedMicroCompactionEngine`) chooses which messages to mark.
  if (markCacheBreakpoint && content.length > 0) {
    const last = content[content.length - 1];
    if (last && typeof last === "object") {
      content[content.length - 1] = {
        ...(last as Record<string, unknown>),
        cache_control: { type: "ephemeral" },
      };
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
    case "thinking":
      return { type: "thinking", thinking: block.text };
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
          text: block.preview + (block.hasMore
            ? `\n\n[Truncated: original ${block.originalBytes} bytes, file: ${block.path}]`
            : ""),
        }],
        is_error: false,
      };
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
