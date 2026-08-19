import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalToolChoice,
  CanonicalToolSchema,
  ModelDefinition,
  ProviderConfig,
  CanonicalModelRequest,
} from "../../protocol/canonical.js";
import { flattenToolResultBlockText } from "../../protocol/toolResultContent.js";
import { messageContent } from "../../protocol/clone.js";
import { normalizeOpenAISchema } from "../openai/schema.js";
import { resolveThinkingPlan, throwIfUnsupportedThinkingPlan } from "../../thinking/registry.js";
import { formatToolResultReferenceText } from "../toolResultReferenceText.js";
import { isCodexSubscriptionProvider } from "../codex/client.js";
import { normalizeCodexHistory } from "../codex/history.js";
import { ModelProviderError } from "../../protocol/errors.js";

export type OpenAIResponsesRequestBody = {
  model: string;
  input: OpenAIResponsesInputItem[];
  instructions?: string;
  max_output_tokens?: number;
  stream?: boolean;
  temperature?: number;
  metadata?: Record<string, unknown>;
  tools?: OpenAIResponsesTool[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  text?: {
    format: {
      type: "json_schema";
      name: string;
      description?: string;
      schema: Record<string, unknown>;
      strict?: boolean;
    };
  };
  store?: boolean;
  include?: Array<"reasoning.encrypted_content">;
  reasoning?: {
    effort?: string;
    summary?: "auto";
  };
  enable_thinking?: boolean;
  thinking_budget?: number;
};

type OpenAIResponsesInputItem =
  | {
      role: "user" | "assistant";
      content: Array<Record<string, unknown>>;
    }
  | {
      type: "function_call";
      id?: string;
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "reasoning";
      id: string;
      encrypted_content: string;
      summary: Array<{ type: "summary_text"; text: string }>;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    };

type OpenAIResponsesTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict: boolean;
};

export function buildOpenAIResponsesRequest(
  request: CanonicalModelRequest,
  model: ModelDefinition,
  _provider?: ProviderConfig,
): OpenAIResponsesRequestBody {
  const thinkingPlan = resolveThinkingPlan(request.thinking, _provider ?? { id: "openai", protocol: "openai-responses", url: "", apiKey: "", headers: {}, models: {} }, model);
  throwIfUnsupportedThinkingPlan(thinkingPlan, request);
  const isCodex = Boolean(_provider && isCodexSubscriptionProvider(_provider));
  const messages = isCodex
    ? normalizeCodexHistory(request.messages)
    : request.messages;
  const responseTools = request.tools?.map((tool) => toResponsesTool(tool, !isCodex));
  let input = messages.flatMap((message) => toResponsesInputItems(message, isCodex));
  if (isCodex && input.length === 0) {
    input = request.messages
      .flatMap((message) => toResponsesInputItems(withoutToolBlocks(message), isCodex))
      .slice(-1);
    if (input.length === 0) {
      throw new ModelProviderError({
        provider: _provider!.id,
        model: request.model,
        protocol: _provider!.protocol,
        code: "invalid_request",
        message: "Codex request has no meaningful input after malformed tool history was removed.",
        retryable: false,
      });
    }
  }
  const body: OpenAIResponsesRequestBody = {
    model: request.model,
    input,
    instructions: isCodex
      ? request.systemPrompt?.trim() || "You are a helpful coding agent."
      : request.systemPrompt,
    max_output_tokens: isCodex
      ? undefined
      : request.maxOutputTokens ?? model.capabilities.maxOutputTokens,
    tools: isCodex && !responseTools?.length ? undefined : responseTools,
    tool_choice: isCodex && responseTools?.length
      ? toResponsesToolChoice(request.toolChoice ?? "auto")
      : toResponsesToolChoice(request.toolChoice),
    parallel_tool_calls: isCodex && responseTools?.length ? true : undefined,
    temperature: isCodex ? undefined : request.temperature,
    stream: request.stream,
    metadata: !isCodex && request.metadata
      ? Object.fromEntries(
          Object.entries(request.metadata).map(([key, value]) => [key, String(value)]),
        )
      : undefined,
    store: false,
    ...(isCodex ? { include: ["reasoning.encrypted_content"] } : {}),
  };

  if (thinkingPlan.useOpenAIReasoning && thinkingPlan.effort) {
    body.reasoning = {
      effort: thinkingPlan.effort,
      ...(isCodex ? { summary: "auto" as const } : {}),
    };
  } else if (thinkingPlan.bodyPatch) {
    Object.assign(body, thinkingPlan.bodyPatch);
  } else if (isCodex && request.thinking?.enabled !== false) {
    body.reasoning = {
      effort: "medium",
      summary: "auto",
    };
  }

  if (request.outputSchema) {
    body.text = {
      format: {
        type: "json_schema",
        name: request.outputSchema.name,
        description: request.outputSchema.description,
        schema: normalizeOpenAISchema(request.outputSchema.schema),
        strict: request.outputSchema.strict ?? true,
      },
    };
  }

  return body;
}

function withoutToolBlocks(message: CanonicalMessage): CanonicalMessage {
  return {
    ...message,
    content: message.content.filter((block) =>
      block.type !== "tool_call"
      && block.type !== "tool_result"
      && block.type !== "tool_result_reference"
    ),
  };
}

function toResponsesInputItems(
  message: CanonicalMessage,
  isCodex: boolean,
): OpenAIResponsesInputItem[] {
  const items: OpenAIResponsesInputItem[] = [];
  const normalContent: CanonicalContentBlock[] = [];
  const content = messageContent(message);

  const flushContent = () => {
    if (normalContent.length === 0) return;
    const content = normalContent.flatMap((block) =>
      toResponsesContentPart(block, message.role, isCodex)
    );
    if (content.length > 0) {
      items.push({ role: message.role, content });
    }
    normalContent.length = 0;
  };

  for (const block of content) {
    if (
      block.type === "thinking"
      && isCodex
      && block.responsesItemId
      && block.encryptedReasoningContent
    ) {
      flushContent();
      items.push({
        type: "reasoning",
        id: block.responsesItemId,
        encrypted_content: block.encryptedReasoningContent,
        summary: block.text
          ? [{ type: "summary_text", text: block.text }]
          : [],
      });
      continue;
    }

    if (block.type === "tool_call") {
      flushContent();
      items.push({
        type: "function_call",
        ...(isCodex && block.responsesItemId ? { id: block.responsesItemId } : {}),
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      });
      continue;
    }

    if (block.type === "tool_result") {
      flushContent();
      items.push({
        type: "function_call_output",
        call_id: block.toolCallId,
        output: flattenToolResultBlockText(block),
      });
      const visualContent = block.content.filter((part) => part.type === "image" || part.type === "pdf");
      if (visualContent.length > 0) {
        items.push({
          role: "user",
          content: [
            { type: "input_text", text: "[Visual content from tool result]" },
            ...visualContent.flatMap((part) => toResponsesContentPart(part, "user", isCodex)),
          ],
        });
      }
      continue;
    }

    if (block.type === "tool_result_reference") {
      flushContent();
      items.push({
        type: "function_call_output",
        call_id: block.toolCallId,
        output: formatToolResultReferenceText(block),
      });
      continue;
    }

    normalContent.push(block);
  }

  flushContent();
  return items;
}

function toResponsesContentPart(
  block: CanonicalContentBlock,
  role: CanonicalMessage["role"],
  isCodex: boolean,
): Record<string, unknown>[] {
  const textType = isCodex && role === "assistant" ? "output_text" : "input_text";
  switch (block.type) {
    case "text":
      return [{ type: textType, text: block.text }];
    case "thinking":
      return [{ type: textType, text: block.text }];
    case "image":
      if (isCodex && role === "assistant") return [];
      return [{
        type: "input_image",
        image_url: block.source === "url" ? block.data : `data:${block.mimeType};base64,${block.data}`,
        detail: block.detail,
      }];
    case "pdf":
      if (isCodex && role === "assistant") return [];
      return [{
        type: "input_file",
        filename: "document.pdf",
        file_data: `data:${block.mimeType};base64,${block.data}`,
      }];
    case "audio":
      return block.source === "url"
        ? [{ type: textType, text: `[Audio URL: ${block.data}]` }]
        : [{ type: textType, text: "[Audio content omitted]" }];
    case "media_reference":
      return [{ type: textType, text: block.preview }];
    case "tool_call":
    case "tool_result":
    case "tool_result_reference":
      return [];
  }
}

function toResponsesTool(
  tool: CanonicalToolSchema,
  strict: boolean,
): OpenAIResponsesTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: normalizeOpenAISchema(tool.inputSchema),
    strict,
  };
}

function toResponsesToolChoice(toolChoice: CanonicalToolChoice | undefined): unknown {
  if (!toolChoice) {
    return undefined;
  }

  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }

  return { type: "function", name: toolChoice.name };
}
