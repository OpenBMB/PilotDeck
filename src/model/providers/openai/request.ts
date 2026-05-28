import type {
  CanonicalContentBlock,
  CanonicalImageBlock,
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalPdfBlock,
  CanonicalToolChoice,
  CanonicalToolSchema,
  ModelDefinition,
} from "../../protocol/canonical.js";
import { flattenToolResultBlockText } from "../../protocol/toolResultContent.js";

export type OpenAIRequestBody = {
  model: string;
  messages: OpenAIMessage[];
  max_tokens: number;
  tools?: OpenAITool[];
  tool_choice?: unknown;
  temperature?: number;
  stream?: boolean;
  metadata?: Record<string, unknown>;
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

type OpenAIToolCall = {
  id?: unknown;
  type?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
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
): OpenAIRequestBody {
  const messages = sanitizeOpenAIToolMessages(
    request.messages.flatMap((message, messageIndex) => toOpenAIMessages(message, messageIndex)),
  );
  if (request.systemPrompt) {
    messages.unshift({ role: "system", content: request.systemPrompt });
  }

  const body: OpenAIRequestBody = {
    model: request.model,
    messages,
    max_tokens: request.maxOutputTokens ?? model.capabilities.maxOutputTokens,
    tools: request.tools?.map(toOpenAITool),
    tool_choice: toOpenAIToolChoice(request.toolChoice),
    temperature: request.temperature,
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
        schema: request.outputSchema.schema,
        strict: request.outputSchema.strict ?? true,
      },
    };
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
    .map((block, toolCallIndex) => ({
      id: normalizeToolCallId(block.id, messageIndex, toolCallIndex),
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
    }
  }).filter(Boolean);
}

function toOpenAITool(tool: CanonicalToolSchema): OpenAITool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeOpenAISchema(tool.inputSchema),
    },
  };
}

/**
 * Azure/OpenAI-compatible endpoints can require `items` whenever a schema node
 * allows `array` (including union types like `type: ["string", "array"]`).
 * Normalize tool input schemas defensively to avoid provider-side 400s.
 */
function normalizeOpenAISchema(schema: Record<string, unknown>): Record<string, unknown> {
  return normalizeOpenAISchemaNode(schema) as Record<string, unknown>;
}

function normalizeOpenAISchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(normalizeOpenAISchemaNode);
  }
  if (!isRecord(node)) {
    return node;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    normalized[key] = normalizeOpenAISchemaNode(value);
  }

  const typeField = normalized.type;
  const allowsArray = typeField === "array"
    || (Array.isArray(typeField) && typeField.includes("array"));
  if (allowsArray && !("items" in normalized)) {
    normalized.items = {};
  }

  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeToolCallId(id: unknown, messageIndex: number, toolCallIndex: number): string {
  return typeof id === "string" && id.trim().length > 0
    ? id
    : `call_${messageIndex}_${toolCallIndex}`;
}

/**
 * Last-resort safety net for OpenAI-compatible providers with strict tool
 * history validation (DeepSeek in particular):
 *   - every assistant tool call has a non-empty `id` and `type:"function"`;
 *   - matching tool messages are moved immediately after that assistant;
 *   - missing tool results get placeholders;
 *   - orphan tool messages are dropped so `role:"tool"` never appears without
 *     a directly preceding assistant `tool_calls` message.
 */
function sanitizeOpenAIToolMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  const usedToolCallIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "tool") {
      continue;
    }

    if (msg.role !== "assistant" || !msg.tool_calls?.length) {
      out.push(msg);
      continue;
    }

    const { toolCalls, remap } = normalizeAssistantToolCalls(msg.tool_calls, out.length, usedToolCallIds);
    if (toolCalls.length === 0) {
      const { tool_calls: _toolCalls, ...withoutToolCalls } = msg;
      out.push(withoutToolCalls);
      continue;
    }

    const collected = new Map<string, OpenAIMessage>();
    const deferred: OpenAIMessage[] = [];
    let j = i + 1;
    while (j < messages.length && messages[j].role !== "assistant") {
      const next = messages[j];
      if (next.role === "tool") {
        const mapped = normalizeToolMessageForCalls(next, toolCalls, remap, collected);
        if (mapped) {
          collected.set(mapped.tool_call_id!, mapped);
        }
      } else {
        deferred.push(next);
      }
      j++;
    }

    out.push({
      ...msg,
      content: msg.content ?? "",
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      out.push(
        collected.get(call.id) ?? {
          role: "tool",
          tool_call_id: call.id,
          content: "[result truncated]",
        },
      );
    }

    out.push(...deferred);
    i = j - 1;
  }
  return out;
}

function normalizeAssistantToolCalls(
  toolCalls: unknown[],
  messageIndex: number,
  usedToolCallIds: Set<string>,
): { toolCalls: Array<Required<OpenAIToolCall> & { id: string }>; remap: Map<string, string> } {
  const normalized: Array<Required<OpenAIToolCall> & { id: string }> = [];
  const remap = new Map<string, string>();

  toolCalls.forEach((toolCall, callIndex) => {
    const record = isRecord(toolCall) ? (toolCall as OpenAIToolCall) : {};
    const fn = isRecord(record.function) ? record.function : {};
    const originalId = typeof record.id === "string" ? record.id.trim() : "";
    const id = reserveToolCallId(originalId, messageIndex, callIndex, usedToolCallIds);
    if (originalId && !remap.has(originalId)) {
      remap.set(originalId, id);
    }

    normalized.push({
      id,
      type: "function",
      function: {
        name: typeof fn.name === "string" ? fn.name : "",
        arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    });
  });

  return { toolCalls: normalized, remap };
}

function reserveToolCallId(
  originalId: string,
  messageIndex: number,
  callIndex: number,
  usedToolCallIds: Set<string>,
): string {
  const base = originalId || `call_${messageIndex}_${callIndex}`;
  let id = base;
  let suffix = 1;
  while (usedToolCallIds.has(id)) {
    id = `${base}_${suffix}`;
    suffix += 1;
  }
  usedToolCallIds.add(id);
  return id;
}

function normalizeToolMessageForCalls(
  message: OpenAIMessage,
  toolCalls: Array<{ id: string }>,
  remap: Map<string, string>,
  collected: Map<string, OpenAIMessage>,
): OpenAIMessage | undefined {
  const originalId = typeof message.tool_call_id === "string" ? message.tool_call_id.trim() : "";
  let id = originalId ? (remap.get(originalId) ?? originalId) : "";

  if (!id || !toolCalls.some((call) => call.id === id) || collected.has(id)) {
    const nextUnclaimed = toolCalls.find((call) => !collected.has(call.id));
    if (!nextUnclaimed || (originalId && !remap.has(originalId))) {
      return undefined;
    }
    id = nextUnclaimed.id;
  }

  return {
    role: "tool",
    tool_call_id: id,
    content: message.content ?? "",
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
