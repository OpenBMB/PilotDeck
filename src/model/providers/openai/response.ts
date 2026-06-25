import { jsonrepair } from "jsonrepair";
import { randomUUID } from "node:crypto";
import type {
  CanonicalContentBlock,
  CanonicalModelResponse,
  CanonicalToolCallBlock,
} from "../../protocol/canonical.js";
import { ModelProviderError } from "../../protocol/errors.js";
import { normalizeOpenAIFinishReason } from "../../response/normalizeFinishReason.js";
import { normalizeOpenAIUsage } from "../../response/normalizeUsage.js";

type OpenAIResponseToolCallIdState = {
  baseId: string;
  usedToolCallIds: Set<string>;
};

export function parseOpenAIResponse(raw: unknown, provider = "openai"): CanonicalModelResponse {
  const response = asRecord(raw);
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const firstChoice = asRecord(choices[0]);
  const choiceIndex = typeof firstChoice.index === "number" ? firstChoice.index : 0;
  const message = asRecord(firstChoice.message);
  const content: CanonicalContentBlock[] = [];
  const idState = createResponseToolCallIdState(response);

  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const p = asRecord(part);
      if (p.type === "text" && typeof p.text === "string" && p.text.length > 0) {
        content.push({ type: "text", text: p.text });
      }
    }
  }

  if (Array.isArray(message.tool_calls)) {
    content.push(...message.tool_calls.map((toolCall, toolIndex) =>
      toCanonicalToolCall(toolCall, provider, idState, choiceIndex, toolIndex)
    ));
  }

  return {
    role: "assistant",
    content,
    usage: normalizeOpenAIUsage(response.usage),
    finishReason: normalizeOpenAIFinishReason(firstChoice.finish_reason),
    raw,
  };
}

function toCanonicalToolCall(
  toolCall: unknown,
  provider: string,
  idState: OpenAIResponseToolCallIdState,
  choiceIndex: number,
  toolIndex: number,
): CanonicalToolCallBlock {
  const record = asRecord(toolCall);
  const fn = asRecord(record.function);
  const rawArguments = typeof fn.arguments === "string" ? fn.arguments : "{}";

  let input: unknown;
  try {
    input = JSON.parse(rawArguments);
  } catch {
    try {
      const repaired = jsonrepair(rawArguments);
      input = JSON.parse(repaired);
      console.warn(`[openai-response] repaired invalid JSON for tool call (len=${rawArguments.length})`);
    } catch {
      throw new ModelProviderError({
        provider,
        protocol: "openai",
        code: "invalid_tool_arguments",
        message: "OpenAI tool call arguments are not valid JSON.",
        retryable: true,
        raw: toolCall,
      });
    }
  }

  return {
    type: "tool_call",
    id: chooseResponseToolCallId(idState, readNonEmptyString(record.id), choiceIndex, toolIndex),
    name: typeof fn.name === "string" ? fn.name : "",
    input,
    raw: toolCall,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function createResponseToolCallIdState(response: Record<string, unknown>): OpenAIResponseToolCallIdState {
  return {
    baseId: safeToolCallIdPart(readNonEmptyString(response.id) ?? `response_${randomUUID().slice(0, 12)}`),
    usedToolCallIds: new Set(),
  };
}

function chooseResponseToolCallId(
  state: OpenAIResponseToolCallIdState,
  incomingId: string | undefined,
  choiceIndex: number,
  toolIndex: number,
): string {
  const candidate = incomingId !== undefined && !state.usedToolCallIds.has(incomingId)
    ? incomingId
    : generateToolCallId(state, choiceIndex, toolIndex);
  const id = nextUniqueToolCallId(candidate, state.usedToolCallIds);
  state.usedToolCallIds.add(id);
  return id;
}

function generateToolCallId(
  state: OpenAIResponseToolCallIdState,
  choiceIndex: number,
  toolIndex: number,
): string {
  return `call_${state.baseId}_${choiceIndex}_${toolIndex}`;
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

function safeToolCallIdPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "response";
}
