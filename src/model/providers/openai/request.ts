import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalToolChoice,
  CanonicalToolSchema,
  ModelDefinition,
} from "../../protocol/canonical.js";

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
  /**
   * OpenRouter / DeepSeek reasoning control. When `thinking` is explicitly
   * disabled on the canonical request, we lower it to `{ enabled: false }`
   * so reasoning models skip chain-of-thought (saves latency + tokens).
   */
  reasoning?: { enabled: boolean };
  /**
   * When streaming, request the provider to include a final usage chunk.
   * Without this, OpenAI-compatible providers never report token counts
   * in streaming mode and the router falls back to estimation.
   */
  stream_options?: { include_usage: boolean };
};

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | unknown[];
  tool_calls?: unknown[];
  tool_call_id?: string;
  /**
   * Reasoning providers (DeepSeek's `deepseek-reasoner` / `deepseek-v4-pro`,
   * etc.) require the prior turn's chain-of-thought to be echoed back in
   * this field on every follow-up request, otherwise the API rejects the
   * call with "The reasoning_content in the thinking mode must be passed
   * back to the API". Providers that don't recognize the field just
   * ignore it.
   */
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
  const messages = request.messages.flatMap(toOpenAIMessages);
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
    metadata: request.metadata,
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

  if (body.stream) {
    body.stream_options = { include_usage: true };
  }

  if (request.thinking?.enabled === false) {
    body.reasoning = { enabled: false };
  }

  return body;
}

function toOpenAIMessages(message: CanonicalMessage): OpenAIMessage[] {
  const toolResultMessages = message.content
    .filter((block) => block.type === "tool_result")
    .map((block) => ({
      role: "tool" as const,
      tool_call_id: block.toolCallId,
      content: block.content.map((content) => content.text).join("\n"),
    }));

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

  // Split thinking blocks out of the regular content stream: reasoning
  // providers (DeepSeek `deepseek-reasoner` / `deepseek-v4-pro`) expect
  // them to be echoed back via the separate `reasoning_content` field,
  // and they reject requests that hide the prior reasoning inside
  // `content`. Non-reasoning providers ignore `reasoning_content`.
  const reasoningBlocks = message.content.filter((block) => block.type === "thinking");
  const reasoningText = reasoningBlocks
    .map((block) => (block.type === "thinking" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");

  const normalContent = message.content.filter(
    (block) =>
      block.type !== "tool_result"
      && block.type !== "tool_call"
      && block.type !== "thinking",
  );

  const messages: OpenAIMessage[] = [];
  if (normalContent.length > 0 || assistantToolCalls.length > 0 || reasoningText.length > 0) {
    const entry: OpenAIMessage = {
      role: message.role,
      content: normalContent.length > 0 ? toOpenAIContent(normalContent) : undefined,
      tool_calls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
    };
    if (reasoningText.length > 0 && message.role === "assistant") {
      entry.reasoning_content = reasoningText;
    }
    messages.push(entry);
  }

  return [...messages, ...toolResultMessages];
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
          type: "file",
          file: {
            filename: "input.pdf",
            file_data: `data:${block.mimeType};base64,${block.data}`,
          },
        };
      case "tool_call":
      case "tool_result":
        return undefined;
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

function toOpenAIToolChoice(toolChoice: CanonicalToolChoice | undefined): unknown {
  if (!toolChoice) {
    return undefined;
  }

  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }

  return { type: "function", function: { name: toolChoice.name } };
}
