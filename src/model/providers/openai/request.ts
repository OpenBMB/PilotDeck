import type {
  CanonicalContentBlock,
  CanonicalImageBlock,
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalPdfBlock,
  CanonicalToolChoice,
  CanonicalToolSchema,
  ModelDefinition,
  ProviderConfig,
} from "../../protocol/canonical.js";
import { flattenToolResultBlockText } from "../../protocol/toolResultContent.js";
import { cleanSchemaForGoogle, normalizeGoogleToolSchema } from "../google/schema.js";
import { normalizeOpenAISchema } from "./schema.js";
import { resolveThinkingPlan, throwIfUnsupportedThinkingPlan } from "../../thinking/registry.js";

export type OpenAIRequestBody = {
  model: string;
  messages: OpenAIMessage[];
  max_tokens: number;
  tools?: OpenAITool[];
  tool_choice?: unknown;
  temperature?: number;
  stream?: boolean;
  metadata?: Record<string, unknown>;
  reasoning?: { effort?: string };
  thinking?: Record<string, unknown>;
  reasoning_effort?: string;
  reasoning_split?: boolean;
  /**
   * Provider-native structured output. Set when `request.outputSchema` is
   * provided. `strict` defaults to true unless the schema opts out.
   */
  response_format?: {
    type: "json_schema";
    json_schema: {
      name: string;
      description?: string;
      schema: Record<string, unknown>;
      strict?: boolean;
    };
  };
};

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | unknown[];
  tool_calls?: unknown[];
  tool_call_id?: string;
  reasoning_content?: string;
};

type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export function buildOpenAIRequest(
  request: CanonicalModelRequest,
  model: ModelDefinition,
  provider?: ProviderConfig,
): OpenAIRequestBody {
  const googleOpenAICompatible = isGoogleOpenAICompatibleProvider(provider);
  const thinkingPlan = resolveThinkingPlan(request.thinking, provider ?? { id: "openai", protocol: "openai", url: "", apiKey: "", headers: {}, models: {} }, model);
  throwIfUnsupportedThinkingPlan(thinkingPlan, request);
  const messages = repairOpenAIToolPairing(
    request.messages.flatMap((message, messageIndex) => toOpenAIMessages(message, messageIndex)),
  );
  if (request.systemPrompt) {
    messages.unshift({ role: "system", content: request.systemPrompt });
  }

  const body: OpenAIRequestBody = {
    model: request.model,
    messages,
    max_tokens: request.maxOutputTokens ?? model.capabilities.maxOutputTokens,
    tools: request.tools?.map((tool) => toOpenAITool(tool, googleOpenAICompatible)),
    tool_choice: toOpenAIToolChoice(request.toolChoice),
    temperature: thinkingPlan.omitTemperature ? undefined : request.temperature,
    stream: request.stream,
    metadata: request.metadata
      ? Object.fromEntries(
          Object.entries(request.metadata).map(([k, v]) => [k, String(v)]),
        )
      : undefined,
  };

  if (request.outputSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: request.outputSchema.name,
        description: request.outputSchema.description,
        schema: googleOpenAICompatible
          ? normalizeGoogleOpenAIResponseSchema(request.outputSchema.schema)
          : request.outputSchema.schema,
        strict: request.outputSchema.strict ?? true,
      },
    };
  }

  if (thinkingPlan.useOpenAIReasoning && thinkingPlan.effort) {
    body.reasoning = { effort: thinkingPlan.effort };
  } else if (thinkingPlan.bodyPatch) {
    Object.assign(body, thinkingPlan.bodyPatch);
  } else if (thinkingPlan.useOpenAICompatibleThinking) {
    if (thinkingPlan.thinkingType) {
      body.thinking = { type: thinkingPlan.thinkingType };
    } else if (thinkingPlan.enabled) {
      body.thinking = { type: "enabled" };
    }
    if (thinkingPlan.effort) {
      body.reasoning_effort = thinkingPlan.effort;
    }
  } else if (thinkingPlan.splitReasoning) {
    body.reasoning_split = true;
  } else if (request.thinking?.enabled) {
    (body as Record<string, unknown>).enable_thinking = true;
    const budget = request.thinking.budgetTokens;
    if (googleOpenAICompatible) {
      if (typeof budget === "number" && Number.isFinite(budget) && budget >= 0) {
        (body as Record<string, unknown>).thinking_budget = budget;
      }
    } else if (budget) {
      (body as Record<string, unknown>).thinking_budget = budget;
    }
  }

  return body;
}

function toOpenAIMessages(message: CanonicalMessage, messageIndex: number): OpenAIMessage[] {
  if (message.role === "user") {
    return toOpenAIUserMessages(message);
  }

  const toolResultBlocks = message.content
    .filter((block) => block.type === "tool_result");
  const toolResultMessages = toolResultBlocks.map(toOpenAIToolResultMessage);
  const toolResultVisualMessages = toolResultBlocks.flatMap(toOpenAIToolResultVisualMessages);

  const toolResultRefMessages = message.content
    .filter((block) => block.type === "tool_result_reference")
    .map(toOpenAIToolResultReferenceMessage);

  const assistantToolCalls = message.content
    .filter((block) => block.type === "tool_call")
    .map((block) => ({
      // Preserve the canonical id until `repairOpenAIToolPairing` can see the
      // adjacent tool results and rewrite both sides together.
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      },
    }));

  const thinkingBlocks = message.content.filter((block) => block.type === "thinking");
  const normalContent = message.content.filter(
    (block) =>
      block.type !== "tool_result" &&
      block.type !== "tool_result_reference" &&
      block.type !== "tool_call" &&
      block.type !== "thinking",
  );

  const messages: OpenAIMessage[] = [];
  if (normalContent.length > 0 || assistantToolCalls.length > 0 || thinkingBlocks.length > 0) {
    const msg: OpenAIMessage = {
      role: message.role,
      content: normalContent.length > 0
        ? toOpenAIContent(normalContent)
        : (message.role === "assistant" && thinkingBlocks.length > 0 ? "" : undefined),
      tool_calls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
    };
    // DeepSeek V4 requires reasoning_content to be passed back on assistant
    // messages in multi-turn conversations; omitting it causes a 400 error.
    if (message.role === "assistant" && thinkingBlocks.length > 0) {
      msg.reasoning_content = thinkingBlocks.map((b) => b.text).join("\n");
    }
    messages.push(msg);
  }

  return [...messages, ...toolResultMessages, ...toolResultRefMessages, ...toolResultVisualMessages];
}

function toOpenAIUserMessages(message: CanonicalMessage): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  let normalContent: CanonicalContentBlock[] = [];

  const flushNormalContent = () => {
    if (normalContent.length === 0) return;
    messages.push({
      role: "user",
      content: toOpenAIContent(normalContent),
    });
    normalContent = [];
  };

  for (let i = 0; i < message.content.length; i += 1) {
    const block = message.content[i];
    if (block.type === "tool_result") {
      flushNormalContent();
      const visualContent: CanonicalContentBlock[] = [];
      while (i < message.content.length) {
        const toolBlock = message.content[i];
        if (toolBlock.type === "tool_result") {
          messages.push(toOpenAIToolResultMessage(toolBlock));
          visualContent.push(...toolResultVisualContent(toolBlock));
          i += 1;
          continue;
        }
        if (toolBlock.type === "tool_result_reference") {
          messages.push(toOpenAIToolResultReferenceMessage(toolBlock));
          i += 1;
          continue;
        }
        break;
      }
      i -= 1;
      if (visualContent.length > 0) {
        messages.push({
          role: "user",
          content: toOpenAIContent([
            { type: "text", text: "[Visual content from tool result]" },
            ...visualContent,
          ]),
        });
      }
      continue;
    }
    if (block.type === "tool_result_reference") {
      flushNormalContent();
      messages.push(toOpenAIToolResultReferenceMessage(block));
      continue;
    }
    normalContent.push(block);
  }

  flushNormalContent();
  return messages;
}

function toOpenAIToolResultMessage(
  block: Extract<CanonicalContentBlock, { type: "tool_result" }>,
): OpenAIMessage {
  return {
    role: "tool",
    tool_call_id: block.toolCallId,
    content: flattenToolResultBlockText(block),
  };
}

function toOpenAIToolResultVisualMessages(
  block: Extract<CanonicalContentBlock, { type: "tool_result" }>,
): OpenAIMessage[] {
  const visualContent = toolResultVisualContent(block);
  if (visualContent.length === 0) {
    return [];
  }
  return [{
    role: "user",
    content: toOpenAIContent([
      { type: "text", text: "[Visual content from tool result]" },
      ...visualContent,
    ]),
  }];
}

function toolResultVisualContent(
  block: Extract<CanonicalContentBlock, { type: "tool_result" }>,
): (CanonicalImageBlock | CanonicalPdfBlock)[] {
  return block.content.filter(
    (content): content is CanonicalImageBlock | CanonicalPdfBlock =>
      content.type === "image" || content.type === "pdf",
  );
}

function toOpenAIToolResultReferenceMessage(
  block: Extract<CanonicalContentBlock, { type: "tool_result_reference" }>,
): OpenAIMessage {
  return {
    role: "tool",
    tool_call_id: block.toolCallId,
    content: block.preview + (block.hasMore
      ? `\n\n[Truncated: original ${block.originalBytes} bytes, file: ${block.path}]`
      : ""),
  };
}

function toOpenAIContent(blocks: CanonicalContentBlock[]): string | unknown[] {
  if (blocks.every((block) => block.type === "text")) {
    return blocks.map((block) => block.text).join("\n");
  }

  return blocks.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "thinking":
        return { type: "text", text: block.text };
      case "image":
        return {
          type: "image_url",
          image_url: {
            url: block.source === "url" ? block.data : `data:${block.mimeType};base64,${block.data}`,
            detail: block.detail,
          },
        };
      case "audio":
        return block.source === "url"
          ? { type: "input_audio", audio_url: block.data }
          : { type: "input_audio", input_audio: { data: block.data, format: block.mimeType } };
      case "pdf":
        return {
          type: "image_url",
          image_url: {
            url: `data:${block.mimeType};base64,${block.data}`,
          },
        };
      case "tool_call":
      case "tool_result":
        return undefined;
      case "tool_result_reference":
        return { type: "text", text: block.preview };
      case "media_reference":
        return { type: "text", text: block.preview };
    }
  }).filter(Boolean);
}

function toOpenAITool(tool: CanonicalToolSchema, googleOpenAICompatible: boolean): OpenAITool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: googleOpenAICompatible
        ? normalizeGoogleToolSchema(tool.inputSchema)
        : normalizeOpenAISchema(tool.inputSchema),
    },
  };
}

function normalizeGoogleOpenAIResponseSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const cleaned = cleanSchemaForGoogle(schema);
  return cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)
    ? cleaned as Record<string, unknown>
    : {};
}

function isGoogleOpenAICompatibleProvider(provider: ProviderConfig | undefined): boolean {
  if (!provider || provider.protocol !== "openai") {
    return false;
  }
  if (provider.id === "google") {
    return true;
  }

  const rawUrl = provider.url.trim().toLowerCase();
  try {
    const url = new URL(rawUrl);
    return url.hostname === "generativelanguage.googleapis.com"
      && url.pathname.includes("/openai");
  } catch {
    return rawUrl.includes("generativelanguage.googleapis.com")
      && rawUrl.includes("/openai");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeToolCallId(id: unknown, messageIndex: number, toolCallIndex: number): string {
  return typeof id === "string" && id.trim().length > 0
    ? id
    : `call_${messageIndex}_${toolCallIndex}`;
}

type NormalizedOpenAIToolCall = {
  originalId?: string;
  toolCall: { id: string; type: "function"; function: { name: string; arguments: string } };
};

/**
 * Last-resort safety net for OpenAI's strict tool-pairing rules:
 *  - normalize every assistant `tool_calls[]` item to the required shape;
 *  - make assistant tool call ids unique, even for historical empty/duplicate ids;
 *  - keep only immediately-following tool messages whose `tool_call_id`
 *    matches that assistant message, rewriting ids when they were normalized;
 *  - inject placeholders for missing tool results;
 *  - drop orphaned / duplicate / mismatched `role: "tool"` messages.
 */
function repairOpenAIToolPairing(messages: OpenAIMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role !== "assistant" || !msg.tool_calls?.length) {
      if (msg.role !== "tool") {
        out.push(msg);
      }
      continue;
    }

    const expected = normalizeOpenAIToolCalls(msg.tool_calls, i);
    out.push({ ...msg, tool_calls: expected.map((entry) => entry.toolCall) });

    const matched = new Set<NormalizedOpenAIToolCall>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      const match = takeExpectedToolCall(expected, matched, messages[j].tool_call_id);
      if (match) {
        out.push({ ...messages[j], tool_call_id: match.toolCall.id });
        matched.add(match);
      }
      j++;
    }

    // Inject placeholders for any still-missing results.
    for (const missing of expected) {
      if (matched.has(missing)) {
        continue;
      }
      out.push({
        role: "tool",
        tool_call_id: missing.toolCall.id,
        content: "[result truncated]",
      });
    }
    i = j - 1;
  }
  return out;
}

function normalizeOpenAIToolCalls(
  toolCalls: unknown[],
  messageIndex: number,
): NormalizedOpenAIToolCall[] {
  const used = new Set<string>();
  return toolCalls.map((toolCall, toolCallIndex) => {
    const record = isRecord(toolCall) ? toolCall : {};
    const originalId = typeof record.id === "string" ? record.id.trim() : undefined;
    const normalized = normalizeOpenAIToolCall(toolCall, messageIndex, toolCallIndex);
    const id = nextUniqueToolCallId(normalized.id, used);
    used.add(id);
    return {
      originalId,
      toolCall: id === normalized.id ? normalized : { ...normalized, id },
    };
  });
}

function nextUniqueToolCallId(id: string, used: Set<string>): string {
  if (!used.has(id)) {
    return id;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${id}_${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

function takeExpectedToolCall(
  expected: NormalizedOpenAIToolCall[],
  matched: Set<NormalizedOpenAIToolCall>,
  toolCallId: unknown,
): NormalizedOpenAIToolCall | undefined {
  if (typeof toolCallId !== "string") {
    return undefined;
  }
  const id = toolCallId.trim();
  return expected.find((entry) =>
    !matched.has(entry) &&
    (entry.originalId === id || entry.toolCall.id === id)
  );
}

function normalizeOpenAIToolCall(
  toolCall: unknown,
  messageIndex: number,
  toolCallIndex: number,
): { id: string; type: "function"; function: { name: string; arguments: string } } {
  const record = isRecord(toolCall) ? toolCall : {};
  const fn = isRecord(record.function) ? record.function : {};
  const args = fn.arguments;
  return {
    id: normalizeToolCallId(record.id, messageIndex, toolCallIndex),
    type: "function",
    function: {
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    },
  };
}

function toOpenAIToolChoice(toolChoice: CanonicalToolChoice | undefined): unknown {
  if (!toolChoice) {
    return undefined;
  }

  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }

  return { type: "function", function: { name: toolChoice.name } };
}
