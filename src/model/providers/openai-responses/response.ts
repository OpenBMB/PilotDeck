import { jsonrepair } from "jsonrepair";
import { randomUUID } from "node:crypto";
import type {
  CanonicalContentBlock,
  CanonicalModelResponse,
  CanonicalToolCallBlock,
} from "../../protocol/canonical.js";
import { ModelProviderError } from "../../protocol/errors.js";
import { normalizeOpenAIUsage } from "../../response/normalizeUsage.js";
import { classifyOpenAIResponsesTerminal } from "./terminal.js";

type ToolCallIdState = {
  baseId: string;
  usedToolCallIds: Set<string>;
};

export function parseOpenAIResponsesResponse(
  raw: unknown,
  provider = "openai-responses",
): CanonicalModelResponse {
  const response = asRecord(raw);
  const content: CanonicalContentBlock[] = [];
  const idState = createToolCallIdState(response);

  if (typeof response.output_text === "string" && response.output_text.length > 0) {
    content.push({ type: "text", text: response.output_text });
  }

  const output = Array.isArray(response.output) ? response.output : [];
  for (let index = 0; index < output.length; index += 1) {
    const item = asRecord(output[index]);
    if (item.type === "message") {
      content.push(...textBlocksFromMessageItem(item));
    } else if (item.type === "output_refusal" || item.type === "refusal") {
      const refusal = readTextPart(item);
      if (refusal) content.push({ type: "text", text: refusal });
    } else if (item.type === "function_call") {
      content.push(toCanonicalToolCall(item, provider, idState, index));
    } else if (item.type === "reasoning") {
      const reasoning = reasoningText(item);
      const responsesItemId = readNonEmptyString(item.id);
      const encryptedReasoningContent = readNonEmptyString(item.encrypted_content);
      if (reasoning.length > 0 || responsesItemId || encryptedReasoningContent) {
        content.push({
          type: "thinking",
          text: reasoning,
          ...(responsesItemId ? { responsesItemId } : {}),
          ...(encryptedReasoningContent ? { encryptedReasoningContent } : {}),
        });
      }
    }
  }

  const sawToolCall = output.some((item) => asRecord(item).type === "function_call");
  return {
    role: "assistant",
    content: dedupeInitialOutputText(content, response.output_text),
    usage: normalizeOpenAIUsage(response.usage),
    finishReason: classifyOpenAIResponsesTerminal(response, { provider, sawToolCall }).finishReason,
    raw,
  };
}

function textBlocksFromMessageItem(item: Record<string, unknown>): CanonicalContentBlock[] {
  const content = Array.isArray(item.content) ? item.content : [];
  const blocks: CanonicalContentBlock[] = [];
  for (const part of content) {
    const record = asRecord(part);
    const text = readTextPart(record);
    if (text) {
      blocks.push({ type: "text", text });
    }
  }
  return blocks;
}

function readTextPart(part: Record<string, unknown>): string | undefined {
  if (typeof part.text === "string" && part.text.length > 0) {
    return part.text;
  }
  if (typeof part.output_text === "string" && part.output_text.length > 0) {
    return part.output_text;
  }
  if (typeof part.refusal === "string" && part.refusal.length > 0) {
    return part.refusal;
  }
  return undefined;
}

function reasoningText(item: Record<string, unknown>): string {
  const summary = Array.isArray(item.summary) ? item.summary : [];
  return summary
    .map((part) => readTextPart(asRecord(part)))
    .filter((text): text is string => Boolean(text))
    .join("\n");
}

function toCanonicalToolCall(
  item: Record<string, unknown>,
  provider: string,
  idState: ToolCallIdState,
  index: number,
): CanonicalToolCallBlock {
  const rawArguments = typeof item.arguments === "string" ? item.arguments : "{}";
  let input: unknown;
  try {
    input = JSON.parse(rawArguments);
  } catch {
    try {
      input = JSON.parse(jsonrepair(rawArguments));
      console.warn(`[openai-responses] repaired invalid JSON for tool call (len=${rawArguments.length})`);
    } catch {
      throw new ModelProviderError({
        provider,
        protocol: "openai-responses",
        code: "invalid_tool_arguments",
        message: "OpenAI Responses tool call arguments are not valid JSON.",
        retryable: true,
        raw: item,
      });
    }
  }

  return {
    type: "tool_call",
    id: chooseToolCallId(idState, readNonEmptyString(item.call_id) ?? readNonEmptyString(item.id), index),
    name: typeof item.name === "string" ? item.name : "",
    input,
    ...(readNonEmptyString(item.id) ? { responsesItemId: readNonEmptyString(item.id) } : {}),
    raw: item,
  };
}

function dedupeInitialOutputText(
  content: CanonicalContentBlock[],
  outputText: unknown,
): CanonicalContentBlock[] {
  if (typeof outputText !== "string" || outputText.length === 0) {
    return content;
  }
  const [first, ...rest] = content;
  if (first?.type !== "text") {
    return content;
  }
  const restText = rest
    .filter((block): block is Extract<CanonicalContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return restText === outputText ? rest : content;
}

function createToolCallIdState(response: Record<string, unknown>): ToolCallIdState {
  return {
    baseId: safeToolCallIdPart(readNonEmptyString(response.id) ?? `response_${randomUUID().slice(0, 12)}`),
    usedToolCallIds: new Set(),
  };
}

function chooseToolCallId(state: ToolCallIdState, incomingId: string | undefined, index: number): string {
  const candidate = incomingId !== undefined && !state.usedToolCallIds.has(incomingId)
    ? incomingId
    : `call_${state.baseId}_${index}`;
  const id = nextUniqueToolCallId(candidate, state.usedToolCallIds);
  state.usedToolCallIds.add(id);
  return id;
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

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function safeToolCallIdPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "response";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
