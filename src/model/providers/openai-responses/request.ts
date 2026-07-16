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

export type OpenAIResponsesRequestBody = {
  model: string;
  input: OpenAIResponsesInputItem[];
  instructions?: string;
  max_output_tokens: number;
  stream?: boolean;
  temperature?: number;
  metadata?: Record<string, unknown>;
  tools?: OpenAIResponsesTool[];
  tool_choice?: unknown;
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
  reasoning?: {
    effort?: string;
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
      call_id: string;
      name: string;
      arguments: string;
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
  strict: true;
};

export function buildOpenAIResponsesRequest(
  request: CanonicalModelRequest,
  model: ModelDefinition,
  _provider?: ProviderConfig,
): OpenAIResponsesRequestBody {
  const thinkingPlan = resolveThinkingPlan(request.thinking, _provider ?? { id: "openai", protocol: "openai-responses", url: "", apiKey: "", headers: {}, models: {} }, model);
  throwIfUnsupportedThinkingPlan(thinkingPlan, request);
  const body: OpenAIResponsesRequestBody = {
    model: request.model,
    input: request.messages.flatMap(toResponsesInputItems),
    instructions: request.systemPrompt,
    max_output_tokens: request.maxOutputTokens ?? model.capabilities.maxOutputTokens,
    tools: request.tools?.map(toResponsesTool),
    tool_choice: toResponsesToolChoice(request.toolChoice),
    temperature: request.temperature,
    stream: request.stream,
    metadata: request.metadata
      ? Object.fromEntries(
          Object.entries(request.metadata).map(([key, value]) => [key, String(value)]),
        )
      : undefined,
    store: false,
  };

  if (thinkingPlan.useOpenAIReasoning && thinkingPlan.effort) {
    body.reasoning = { effort: thinkingPlan.effort };
  } else if (thinkingPlan.bodyPatch) {
    Object.assign(body, thinkingPlan.bodyPatch);
  }

  if (request.outputSchema) {
    body.text = {
      format: {
        type: "json_schema",
        name: request.outputSchema.name,
        description: request.outputSchema.description,
        schema: request.outputSchema.schema,
        strict: request.outputSchema.strict ?? true,
      },
    };
  }

  return body;
}

function toResponsesInputItems(message: CanonicalMessage): OpenAIResponsesInputItem[] {
  const items: OpenAIResponsesInputItem[] = [];
  const normalContent: CanonicalContentBlock[] = [];
  const content = messageContent(message);

  const flushContent = () => {
    if (normalContent.length === 0) return;
    const content = normalContent.flatMap((block) => toResponsesContentPart(block));
    if (content.length > 0) {
      items.push({ role: message.role, content });
    }
    normalContent.length = 0;
  };

  for (const block of content) {
    if (block.type === "tool_call") {
      flushContent();
      items.push({
        type: "function_call",
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
            ...visualContent.flatMap((part) => toResponsesContentPart(part)),
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

function toResponsesContentPart(block: CanonicalContentBlock): Record<string, unknown>[] {
  switch (block.type) {
    case "text":
      return [{ type: "input_text", text: block.text }];
    case "thinking":
      return [{ type: "input_text", text: block.text }];
    case "image":
      return [{
        type: "input_image",
        image_url: block.source === "url" ? block.data : `data:${block.mimeType};base64,${block.data}`,
        detail: block.detail,
      }];
    case "pdf":
      return [{
        type: "input_file",
        filename: "document.pdf",
        file_data: `data:${block.mimeType};base64,${block.data}`,
      }];
    case "audio":
      return block.source === "url"
        ? [{ type: "input_text", text: `[Audio URL: ${block.data}]` }]
        : [{ type: "input_text", text: "[Audio content omitted]" }];
    case "media_reference":
      return [{ type: "input_text", text: block.preview }];
    case "tool_call":
    case "tool_result":
    case "tool_result_reference":
      return [];
  }
}

function toResponsesTool(tool: CanonicalToolSchema): OpenAIResponsesTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: normalizeOpenAISchema(tool.inputSchema),
    strict: true,
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
