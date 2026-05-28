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
  const messages = repairOpenAIToolPairing(request.messages.flatMap(toOpenAIMessages));
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

function toOpenAIMessages(message: CanonicalMessage): OpenAIMessage[] {
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
    }
  }).filter(Boolean);
}

function toOpenAITool(tool: CanonicalToolSchema): OpenAITool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

/**
 * Last-resort safety net: walk the flattened OpenAI message list and ensure
 * every assistant message with `tool_calls` is immediately followed by `tool`
 * messages covering every `tool_call_id`. Missing ones get a placeholder.
 */
function repairOpenAIToolPairing(messages: OpenAIMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    out.push(msg);

    if (msg.role !== "assistant" || !msg.tool_calls?.length) continue;

    const expectedIds = new Set(
      (msg.tool_calls as Array<{ id: string }>).map((tc) => tc.id),
    );

    // Scan ahead for matching tool messages.
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      const tid = messages[j].tool_call_id;
      if (tid) expectedIds.delete(tid);
      j++;
    }

    // Inject placeholders for any still-missing results.
    for (const missingId of expectedIds) {
      out.push({
        role: "tool",
        tool_call_id: missingId,
        content: "[result truncated]",
      });
    }
  }
  return out;
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
